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
const threadResultValidator = v.object({ threadId: v.id("threads"), slug: v.optional(v.string()), status: terminalStatusValidator });
const replyResultValidator = v.object({ replyId: v.id("replies"), status: terminalStatusValidator });
const profileLinkValidator = v.object({ label: v.string(), url: v.string() });

const threadContentArgs = {
  title: v.string(),
  body: v.string(),
  metadata: v.array(metadataValidator),
  imageStorageId: v.optional(v.id("_storage")),
  projectUrl: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  imageAltText: v.optional(v.string()),
};

type ModerationOutcome = { flagged: boolean; categories: string[]; model: string };
type ThreadActionResult = { threadId: Id<"threads">; slug?: string; status: "approved" | "rejected" };
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
      if (!applied.applied) throw new ModerationServiceError("attempt_stale", false);
      return { threadId: pending.threadId, ...(applied.slug === undefined ? {} : { slug: applied.slug }), status: outcome.flagged ? "rejected" : "approved" };
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
      if (!applied.applied) throw new ModerationServiceError("attempt_stale", false);
      return { threadId: pending.threadId, ...(applied.slug === undefined ? {} : { slug: applied.slug }), status: outcome.flagged ? "rejected" : "approved" };
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

export const ensureProfile = action({
  args: { handle: v.string(), bio: v.optional(v.string()) },
  returns: v.id("profiles"),
  handler: async (ctx, args): Promise<Id<"profiles">> => {
    const userId = await requireActionUser(ctx);
    if (args.handle.length > 64 || (args.bio?.length ?? 0) > 280) throw new Error("Profile details are too long.");
    let outcome: ModerationOutcome;
    try {
      outcome = await classifyContent(`Profile handle:\n${args.handle}\n\nBio:\n${args.bio ?? ""}`, null);
    } catch {
      throw new Error("The profile safety check is temporarily unavailable. Try again shortly.");
    }
    if (outcome.flagged) throw new Error("The profile was not created because its public content did not pass the safety check.");
    return await ctx.runMutation(internal.forum.applyProfileSetup, { userId, ...args });
  },
});

export const updateProfile = action({
  args: {
    handle: v.string(),
    displayName: v.string(),
    bio: v.string(),
    githubUrl: v.string(),
    socialLinks: v.array(profileLinkValidator),
    avatarStorageId: v.optional(v.id("_storage")),
    removeAvatar: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireActionUser(ctx);
    if (args.handle.length > 64 || args.displayName.length > 80 || args.bio.length > 280 || args.githubUrl.length > 2048) {
      throw new Error("Profile details are too long.");
    }
    if (args.socialLinks.length > 3 || args.socialLinks.some((link) => link.label.length > 24 || link.url.length > 2048)) {
      throw new Error("Profiles can have up to three short links.");
    }
    const text = [
      `Profile handle:\n${args.handle}`,
      `Display name:\n${args.displayName}`,
      `Bio:\n${args.bio}`,
      `GitHub:\n${args.githubUrl}`,
      ...args.socialLinks.map((link) => `Profile link:\n${link.label}: ${link.url}`),
    ].join("\n\n");
    let imageUrl: string | null = null;
    if (args.avatarStorageId !== undefined) {
      try {
        imageUrl = await ctx.runQuery(internal.forum.getProfileImageUrlForModeration, { userId, imageStorageId: args.avatarStorageId });
      } catch (error) {
        try { await ctx.runMutation(internal.forum.discardProfileImage, { userId, imageStorageId: args.avatarStorageId }); } catch { /* The storage cleanup can be retried by an operator. */ }
        throw error;
      }
    }
    let outcome: ModerationOutcome;
    try {
      outcome = await classifyContent(text, imageUrl);
    } catch {
      if (args.avatarStorageId !== undefined) {
        try { await ctx.runMutation(internal.forum.discardProfileImage, { userId, imageStorageId: args.avatarStorageId }); } catch { /* The storage cleanup can be retried by an operator. */ }
      }
      throw new Error("The profile safety check is temporarily unavailable. Try again without uploading another image.");
    }
    if (outcome.flagged) {
      if (args.avatarStorageId !== undefined) await ctx.runMutation(internal.forum.discardProfileImage, { userId, imageStorageId: args.avatarStorageId });
      throw new Error("The profile was not updated because its public content did not pass the safety check.");
    }
    try {
      await ctx.runMutation(internal.forum.applyProfileUpdate, { userId, ...args });
      return null;
    } catch (error) {
      if (args.avatarStorageId !== undefined) {
        try { await ctx.runMutation(internal.forum.discardProfileImage, { userId, imageStorageId: args.avatarStorageId }); } catch { /* The storage cleanup can be retried by an operator. */ }
      }
      throw error;
    }
  },
});
