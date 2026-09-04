"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, env } from "./_generated/server";
import {
  boardValidator,
  buildThreadModerationText,
  metadataValidator,
  normalizeReplyBody,
  normalizeSubmissionId,
  normalizeThreadContent,
} from "./contentRules";

const MODERATION_MODEL = "omni-moderation-latest";
const MODERATION_ENDPOINT = "https://api.openai.com/v1/moderations";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 8_000;

const terminalStatusValidator = v.union(v.literal("approved"), v.literal("rejected"));
const threadResultValidator = v.object({ threadId: v.id("threads"), status: terminalStatusValidator });
const replyResultValidator = v.object({ replyId: v.id("replies"), status: terminalStatusValidator });

const threadContentArgs = {
  title: v.string(),
  body: v.string(),
  metadata: v.array(metadataValidator),
  imageStorageId: v.optional(v.id("_storage")),
  projectUrl: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
};

type ModerationOutcome = { flagged: boolean; categories: string[]; model: string };
type ThreadActionResult = { threadId: Id<"threads">; status: "approved" | "rejected" };
type ReplyActionResult = { replyId: Id<"replies">; status: "approved" | "rejected" };

class ModerationServiceError extends Error {
  constructor(public readonly code: string, public readonly retryable: boolean) {
    super(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModerationOutcome(value: unknown): ModerationOutcome {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length === 0) {
    throw new ModerationServiceError("invalid_response", true);
  }
  const first = value.results[0];
  if (!isRecord(first) || typeof first.flagged !== "boolean" || !isRecord(first.categories)) {
    throw new ModerationServiceError("invalid_response", true);
  }
  const categories = Object.entries(first.categories)
    .filter((entry): entry is [string, true] => entry[1] === true)
    .map(([category]) => category)
    .sort();
  return {
    flagged: first.flagged,
    categories,
    model: typeof value.model === "string" ? value.model : MODERATION_MODEL,
  };
}

async function wait(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response: Response | null, attempt: number) {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(requested) && requested > 0) return Math.min(requested, MAX_RETRY_DELAY_MS);
  }
  return Math.min(750 * (2 ** attempt) + Math.floor(Math.random() * 250), MAX_RETRY_DELAY_MS);
}

async function classifyContent(text: string, imageUrl: string | null): Promise<ModerationOutcome> {
  const apiKey = env.OPENAI_API_KEY;
  const input = imageUrl === null
    ? text
    : [
      { type: "text", text },
      { type: "image_url", image_url: { url: imageUrl } },
    ];
  let lastError = new ModerationServiceError("network_error", true);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response | null = null;
    try {
      response = await fetch(MODERATION_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: MODERATION_MODEL, input }),
        signal: controller.signal,
      });
      if (response.ok) return parseModerationOutcome(await response.json() as unknown);
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      lastError = new ModerationServiceError(`http_${response.status}`, retryable);
      if (!retryable) throw lastError;
    } catch (error) {
      if (error instanceof ModerationServiceError) lastError = error;
      else lastError = new ModerationServiceError(controller.signal.aborted ? "timeout" : "network_error", true);
      if (!lastError.retryable) throw lastError;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < MAX_ATTEMPTS - 1) await wait(retryDelay(response, attempt));
  }
  throw lastError;
}

async function requireActionUser(ctx: ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Error("Sign in to do that.");
  const userId = await ctx.runQuery(internal.forum.getUserIdByTokenIdentifier, {
    tokenIdentifier: identity.tokenIdentifier,
  });
  if (userId === null) throw new Error("Finish setting up your profile first.");
  return userId;
}

async function recordAttemptFailure(
  ctx: ActionCtx,
  attemptId: Id<"moderationAttempts">,
  attemptCount: number,
  error: unknown,
) {
  const code = error instanceof ModerationServiceError ? error.code : "internal_error";
  try {
    await ctx.runMutation(internal.forum.markModerationAttemptError, { attemptId, attemptCount, errorCode: code });
  } catch {
    // The scheduled watchdog is the fallback if this bookkeeping mutation is unavailable.
  }
}

function pendingError() {
  return new Error("This safety check is already running. Your draft is saved on this device; try again shortly.");
}

function unavailableError() {
  return new Error("The safety check is temporarily unavailable. Your draft is saved on this device; please retry.");
}

export const createThread = action({
  args: {
    submissionId: v.string(),
    board: boardValidator,
    status: v.union(v.literal("draft"), v.literal("published")),
    ...threadContentArgs,
  },
  returns: threadResultValidator,
  handler: async (ctx, args): Promise<ThreadActionResult> => {
    const submissionId = normalizeSubmissionId(args.submissionId);
    const content = normalizeThreadContent(args);
    if (args.board !== "projects" && args.imageStorageId !== undefined) throw new Error("Only project threads can have images.");
    const userId = await requireActionUser(ctx);
    const pending = await ctx.runMutation(internal.forum.beginCreateThread, {
      userId,
      submissionId,
      board: args.board,
      status: args.status,
      imageStorageId: args.imageStorageId,
    });
    if (pending.state === "complete") return { threadId: pending.threadId, status: pending.status };
    if (pending.state === "pending") throw pendingError();
    try {
      const outcome = await classifyContent(buildThreadModerationText(content), pending.imageUrl);
      const applied = await ctx.runMutation(internal.forum.finishThreadModeration, {
        attemptId: pending.attemptId,
        attemptCount: pending.attemptCount,
        threadId: pending.threadId,
        revision: pending.revision,
        flagged: outcome.flagged,
        categories: outcome.categories,
        model: outcome.model,
        safeContent: outcome.flagged ? undefined : content,
      });
      if (!applied) throw new ModerationServiceError("attempt_stale", false);
      return { threadId: pending.threadId, status: outcome.flagged ? "rejected" : "approved" };
    } catch (error) {
      await recordAttemptFailure(ctx, pending.attemptId, pending.attemptCount, error);
      throw unavailableError();
    }
  },
});

export const updateThread = action({
  args: {
    submissionId: v.string(),
    board: boardValidator,
    threadId: v.id("threads"),
    removeImage: v.optional(v.boolean()),
    ...threadContentArgs,
  },
  returns: threadResultValidator,
  handler: async (ctx, args): Promise<ThreadActionResult> => {
    const submissionId = normalizeSubmissionId(args.submissionId);
    const content = normalizeThreadContent(args);
    const userId = await requireActionUser(ctx);
    const pending = await ctx.runMutation(internal.forum.beginThreadEdit, {
      userId,
      submissionId,
      threadId: args.threadId,
      imageStorageId: args.imageStorageId,
      removeImage: args.removeImage ?? false,
    });
    if (pending.state === "complete") return { threadId: pending.threadId, status: pending.status };
    if (pending.state === "pending") throw pendingError();
    if (pending.board !== args.board) {
      await recordAttemptFailure(ctx, pending.attemptId, pending.attemptCount, new ModerationServiceError("board_mismatch", false));
      throw new Error("Thread board changed; reopen the editor and try again.");
    }
    try {
      const outcome = await classifyContent(buildThreadModerationText(content), pending.imageUrl);
      const applied = await ctx.runMutation(internal.forum.finishThreadModeration, {
        attemptId: pending.attemptId,
        attemptCount: pending.attemptCount,
        threadId: pending.threadId,
        revision: pending.revision,
        flagged: outcome.flagged,
        categories: outcome.categories,
        model: outcome.model,
        safeContent: outcome.flagged ? undefined : content,
      });
      if (!applied) throw new ModerationServiceError("attempt_stale", false);
      return { threadId: pending.threadId, status: outcome.flagged ? "rejected" : "approved" };
    } catch (error) {
      await recordAttemptFailure(ctx, pending.attemptId, pending.attemptCount, error);
      throw unavailableError();
    }
  },
});

export const reply = action({
  args: { submissionId: v.string(), threadId: v.id("threads"), body: v.string() },
  returns: replyResultValidator,
  handler: async (ctx, args): Promise<ReplyActionResult> => {
    const submissionId = normalizeSubmissionId(args.submissionId);
    const body = normalizeReplyBody(args.body);
    const userId = await requireActionUser(ctx);
    const pending = await ctx.runMutation(internal.forum.beginCreateReply, { userId, submissionId, threadId: args.threadId });
    if (pending.state === "complete") return { replyId: pending.replyId, status: pending.status };
    if (pending.state === "pending") throw pendingError();
    try {
      const outcome = await classifyContent(body, null);
      const applied = await ctx.runMutation(internal.forum.finishReplyModeration, {
        attemptId: pending.attemptId,
        attemptCount: pending.attemptCount,
        replyId: pending.replyId,
        revision: pending.revision,
        flagged: outcome.flagged,
        categories: outcome.categories,
        model: outcome.model,
        safeBody: outcome.flagged ? undefined : body,
      });
      if (!applied) throw new ModerationServiceError("attempt_stale", false);
      return { replyId: pending.replyId, status: outcome.flagged ? "rejected" : "approved" };
    } catch (error) {
      await recordAttemptFailure(ctx, pending.attemptId, pending.attemptCount, error);
      throw unavailableError();
    }
  },
});

export const updateReply = action({
  args: { submissionId: v.string(), replyId: v.id("replies"), body: v.string() },
  returns: replyResultValidator,
  handler: async (ctx, args): Promise<ReplyActionResult> => {
    const submissionId = normalizeSubmissionId(args.submissionId);
    const body = normalizeReplyBody(args.body);
    const userId = await requireActionUser(ctx);
    const pending = await ctx.runMutation(internal.forum.beginReplyEdit, { userId, submissionId, replyId: args.replyId });
    if (pending.state === "complete") return { replyId: pending.replyId, status: pending.status };
    if (pending.state === "pending") throw pendingError();
    try {
      const outcome = await classifyContent(body, null);
      const applied = await ctx.runMutation(internal.forum.finishReplyModeration, {
        attemptId: pending.attemptId,
        attemptCount: pending.attemptCount,
        replyId: pending.replyId,
        revision: pending.revision,
        flagged: outcome.flagged,
        categories: outcome.categories,
        model: outcome.model,
        safeBody: outcome.flagged ? undefined : body,
      });
      if (!applied) throw new ModerationServiceError("attempt_stale", false);
      return { replyId: pending.replyId, status: outcome.flagged ? "rejected" : "approved" };
    } catch (error) {
      await recordAttemptFailure(ctx, pending.attemptId, pending.attemptCount, error);
      throw unavailableError();
    }
  },
});
