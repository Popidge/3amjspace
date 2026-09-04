import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import {
  boardValidator,
  MAX_PROJECT_IMAGE_BYTES,
  MAX_PROJECT_TAGS,
  metadataValidator,
} from "./contentRules";

const approvedThreadContentValidator = v.object({
  title: v.string(),
  body: v.string(),
  metadata: v.array(metadataValidator),
  projectUrl: v.optional(v.string()),
  tags: v.array(v.string()),
});

const terminalModerationStatusValidator = v.union(v.literal("approved"), v.literal("rejected"));

const beginThreadModerationResultValidator = v.union(
  v.object({
    state: v.literal("ready"),
    attemptId: v.id("moderationAttempts"),
    attemptCount: v.number(),
    threadId: v.id("threads"),
    revision: v.number(),
    imageUrl: v.union(v.string(), v.null()),
    board: boardValidator,
  }),
  v.object({
    state: v.literal("complete"),
    threadId: v.id("threads"),
    status: terminalModerationStatusValidator,
  }),
  v.object({ state: v.literal("pending"), threadId: v.id("threads") }),
);

const beginReplyModerationResultValidator = v.union(
  v.object({
    state: v.literal("ready"),
    attemptId: v.id("moderationAttempts"),
    attemptCount: v.number(),
    replyId: v.id("replies"),
    revision: v.number(),
  }),
  v.object({
    state: v.literal("complete"),
    replyId: v.id("replies"),
    status: terminalModerationStatusValidator,
  }),
  v.object({ state: v.literal("pending"), replyId: v.id("replies") }),
);

const MODERATION_PENDING_TIMEOUT_MS = 90_000;

async function getProfile(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("profiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

async function getUserByTokenIdentifier(
  ctx: QueryCtx | MutationCtx,
  tokenIdentifier: string,
) {
  return await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) => q.eq("tokenIdentifier", tokenIdentifier))
    .unique();
}

async function getCurrentUserId(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return null;
  const user = await getUserByTokenIdentifier(ctx, identity.tokenIdentifier);
  return user?._id ?? null;
}

async function storeCurrentUser(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Error("Sign in first.");
  const existing = await getUserByTokenIdentifier(ctx, identity.tokenIdentifier);
  if (existing === null) {
    return await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      email: identity.email,
      name: identity.name,
    });
  }
  if (existing.email !== identity.email || existing.name !== identity.name) {
    await ctx.db.patch("users", existing._id, {
      email: identity.email,
      name: identity.name,
    });
  }
  return existing._id;
}

async function requireMember(ctx: MutationCtx) {
  const userId = await getCurrentUserId(ctx);
  if (userId === null) throw new Error("Sign in to do that.");
  const profile = await requireMemberById(ctx, userId);
  return { userId, profile };
}

async function requireMemberById(ctx: MutationCtx, userId: Id<"users">) {
  const profile = await getProfile(ctx, userId);
  if (profile === null) throw new Error("Finish setting up your profile first.");
  if (profile.status === "suspended") throw new Error("This account is suspended.");
  return profile;
}

async function requireModerator(ctx: MutationCtx) {
  const member = await requireMember(ctx);
  if (member.profile.role !== "moderator") throw new Error("Moderator access required.");
  return member;
}

function cleanHandle(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
}

async function validateProjectImage(ctx: MutationCtx, imageStorageId: Id<"_storage"> | undefined) {
  if (imageStorageId === undefined) return;
  const metadata = await ctx.db.system.get("_storage", imageStorageId);
  if (metadata === null) throw new Error("That project image was not found.");
  if (!metadata.contentType?.startsWith("image/")) {
    throw new Error("Project uploads must be image files.");
  }
  if (metadata.size > MAX_PROJECT_IMAGE_BYTES) {
    throw new Error("Project images must be 5 MB or smaller.");
  }
}

async function deleteProjectImageIfPresent(ctx: MutationCtx, imageStorageId: Id<"_storage">) {
  const metadata = await ctx.db.system.get("_storage", imageStorageId);
  if (metadata !== null) await ctx.storage.delete(imageStorageId);
}

function isSafetyApproved(status: "pending" | "approved" | "rejected" | "error" | undefined) {
  return status === undefined || status === "approved";
}

async function latestApprovedReplyTime(ctx: MutationCtx, threadId: Id<"threads">, fallback: number) {
  const recentReplies = await ctx.db.query("replies").withIndex("by_threadId", (q) => q.eq("threadId", threadId)).order("desc").take(500);
  return recentReplies.find((replyDoc) => isSafetyApproved(replyDoc.moderationStatus))?._creationTime ?? fallback;
}

async function replaceProjectDetails(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  metadata: Array<{ key: string; value: string }>,
  tags: string[],
) {
  const oldMetadata = await ctx.db.query("projectMetadata").withIndex("by_threadId", (q) => q.eq("threadId", threadId)).take(7);
  const oldTags = await ctx.db.query("projectTags").withIndex("by_threadId", (q) => q.eq("threadId", threadId)).take(MAX_PROJECT_TAGS + 1);
  for (const item of oldMetadata) await ctx.db.delete("projectMetadata", item._id);
  for (const item of oldTags) await ctx.db.delete("projectTags", item._id);
  for (const [order, item] of metadata.entries()) {
    await ctx.db.insert("projectMetadata", { threadId, key: item.key, value: item.value, order });
  }
  for (const [order, tag] of tags.entries()) {
    await ctx.db.insert("projectTags", { threadId, tag, order });
  }
}

function assertAttemptMatches(
  attempt: Doc<"moderationAttempts">,
  userId: Id<"users">,
  kind: Doc<"moderationAttempts">["kind"],
  target: { threadId?: Id<"threads">; replyId?: Id<"replies"> } = {},
) {
  if (attempt.userId !== userId || attempt.kind !== kind) {
    throw new Error("That submission identifier is already in use.");
  }
  if (target.threadId !== undefined && attempt.threadId !== target.threadId) {
    throw new Error("That submission identifier belongs to another thread.");
  }
  if (target.replyId !== undefined && attempt.replyId !== target.replyId) {
    throw new Error("That submission identifier belongs to another reply.");
  }
}

async function getAttemptBySubmissionId(ctx: MutationCtx, submissionId: string) {
  return await ctx.db
    .query("moderationAttempts")
    .withIndex("by_submissionId", (q) => q.eq("submissionId", submissionId))
    .unique();
}

async function scheduleAttemptExpiry(
  ctx: MutationCtx,
  attemptId: Id<"moderationAttempts">,
  attemptCount: number,
) {
  await ctx.scheduler.runAfter(
    MODERATION_PENDING_TIMEOUT_MS,
    internal.forum.expireModerationAttempt,
    { attemptId, attemptCount },
  );
}

async function setAttemptError(
  ctx: MutationCtx,
  attempt: Doc<"moderationAttempts">,
  errorCode: string,
) {
  if (attempt.imageStorageId !== undefined) {
    await deleteProjectImageIfPresent(ctx, attempt.imageStorageId);
  }
  if (attempt.kind === "threadCreate" && attempt.threadId !== undefined) {
    const thread = await ctx.db.get("threads", attempt.threadId);
    if (thread?.moderationStatus === "pending" && thread.moderationRevision === attempt.targetRevision) {
      await ctx.db.patch("threads", thread._id, {
        title: "[safety check unavailable]",
        body: "",
        imageStorageId: undefined,
        projectUrl: undefined,
        moderationStatus: "error",
      });
    }
  } else if (attempt.kind === "threadEdit" && attempt.threadId !== undefined) {
    const thread = await ctx.db.get("threads", attempt.threadId);
    if (thread?.moderationStatus === "pending" && thread.moderationRevision === attempt.targetRevision) {
      await ctx.db.patch("threads", thread._id, {
        moderationStatus: attempt.previousStatus ?? "approved",
      });
    }
  } else if (attempt.kind === "replyCreate" && attempt.replyId !== undefined) {
    const replyDoc = await ctx.db.get("replies", attempt.replyId);
    if (replyDoc?.moderationStatus === "pending" && replyDoc.moderationRevision === attempt.targetRevision) {
      await ctx.db.patch("replies", replyDoc._id, { body: "", moderationStatus: "error" });
    }
  } else if (attempt.kind === "replyEdit" && attempt.replyId !== undefined) {
    const replyDoc = await ctx.db.get("replies", attempt.replyId);
    if (replyDoc?.moderationStatus === "pending" && replyDoc.moderationRevision === attempt.targetRevision) {
      await ctx.db.patch("replies", replyDoc._id, {
        moderationStatus: attempt.previousStatus ?? "approved",
      });
      if (isSafetyApproved(attempt.previousStatus)) {
        const thread = await ctx.db.get("threads", replyDoc.threadId);
        if (thread !== null) {
          await ctx.db.patch("threads", thread._id, {
            replyCount: thread.replyCount + 1,
            lastActivityAt: Math.max(thread.lastActivityAt, replyDoc._creationTime),
          });
        }
      }
    }
  }
  await ctx.db.patch("moderationAttempts", attempt._id, {
    status: "error",
    updatedAt: Date.now(),
    imageStorageId: undefined,
    errorCode: errorCode.slice(0, 64),
  });
}

export const getViewer = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return null;
    const user = await getUserByTokenIdentifier(ctx, identity.tokenIdentifier);
    if (user === null) return { user: null, profile: null };
    const profile = await getProfile(ctx, user._id);
    return { user, profile };
  },
});

export const getUserIdByTokenIdentifier = internalQuery({
  args: { tokenIdentifier: v.string() },
  returns: v.union(v.id("users"), v.null()),
  handler: async (ctx, args) => {
    const user = await getUserByTokenIdentifier(ctx, args.tokenIdentifier);
    return user?._id ?? null;
  },
});

export const generateProjectImageUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await requireMember(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const storeViewer = mutation({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => await storeCurrentUser(ctx),
});

export const ensureProfile = mutation({
  args: { handle: v.string(), bio: v.optional(v.string()) },
  returns: v.id("profiles"),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) throw new Error("Sign in first.");
    let user = await getUserByTokenIdentifier(ctx, identity.tokenIdentifier);
    if (user !== null) {
      const existing = await getProfile(ctx, user._id);
      if (existing !== null) return existing._id;
    }
    const handle = cleanHandle(args.handle);
    if (handle.length < 2) throw new Error("Use at least two letters or numbers.");
    const taken = await ctx.db.query("profiles").withIndex("by_handle", (q) => q.eq("handle", handle)).unique();
    if (taken !== null) throw new Error("That handle is already taken.");
    if (user === null) user = await ctx.db.get("users", await storeCurrentUser(ctx));
    if (user === null) throw new Error("Could not create your local account.");
    const existing = await getProfile(ctx, user._id);
    if (existing !== null) return existing._id;
    return await ctx.db.insert("profiles", {
      userId: user._id,
      handle,
      bio: (args.bio ?? "").trim().slice(0, 280),
      role: "member",
      status: "active",
    });
  },
});

/**
 * Operational bootstrap for production moderators. This is internal so it can
 * only be invoked by a Convex project administrator, never by a browser client.
 */
export const setModeratorByEmail = internalMutation({
  args: { email: v.string(), moderator: v.boolean() },
  returns: v.object({
    profileId: v.id("profiles"),
    role: v.union(v.literal("member"), v.literal("moderator")),
  }),
  handler: async (ctx, args) => {
    const email = args.email.trim();
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (user === null) throw new Error("No account exists for that exact email address.");
    const profile = await getProfile(ctx, user._id);
    if (profile === null) throw new Error("That account has not completed profile setup.");
    const role: "member" | "moderator" = args.moderator ? "moderator" : "member";
    await ctx.db.patch("profiles", profile._id, { role });
    return { profileId: profile._id, role };
  },
});

export const updateProfile = mutation({
  args: { handle: v.string(), bio: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { userId, profile } = await requireMember(ctx);
    const handle = cleanHandle(args.handle);
    if (handle.length < 2) throw new Error("Use at least two letters or numbers.");
    if (handle !== profile.handle) {
      const taken = await ctx.db.query("profiles").withIndex("by_handle", (q) => q.eq("handle", handle)).unique();
      if (taken !== null && taken.userId !== userId) throw new Error("That handle is already taken.");
    }
    await ctx.db.patch("profiles", profile._id, { handle, bio: args.bio.trim().slice(0, 280) });
    return null;
  },
});

export const listBoard = query({
  args: { board: boardValidator, limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 40, 60));
    const viewerId = await getCurrentUserId(ctx);
    const viewerProfile = viewerId === null ? null : await getProfile(ctx, viewerId);
    const published = await ctx.db
      .query("threads")
      .withIndex("by_board_and_status", (q) => q.eq("board", args.board).eq("status", "published"))
      .order("desc")
      .take(Math.min(limit * 2, 120));
    const drafts = args.board === "projects" && viewerId !== null
      ? await ctx.db.query("threads").withIndex("by_board_and_status", (q) => q.eq("board", "projects").eq("status", "draft")).order("desc").take(limit)
      : [];
    const rows = [
      ...published.filter((thread) => isSafetyApproved(thread.moderationStatus) || thread.authorId === viewerId || viewerProfile?.role === "moderator"),
      ...drafts.filter((thread) => thread.authorId === viewerId || viewerProfile?.role === "moderator"),
    ]
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, limit);
    return await Promise.all(rows.map(async (thread) => {
      const profile = await getProfile(ctx, thread.authorId);
      const safetyApproved = isSafetyApproved(thread.moderationStatus);
      return {
        ...thread,
        title: thread.hiddenAt
          ? "[thread removed by moderator]"
          : safetyApproved
            ? thread.title
            : thread.moderationStatus === "pending"
              ? "[awaiting safety check]"
              : thread.moderationStatus === "error"
                ? "[safety check unavailable]"
                : "[removed by automated safety check]",
        body: thread.hiddenAt || !safetyApproved ? "" : thread.body,
        projectUrl: safetyApproved ? thread.projectUrl : undefined,
        authorHandle: profile?.handle ?? "unknown",
      };
    }));
  },
});

export const listFeatured = query({
  args: { limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("featuredProjects").withIndex("by_order").order("asc").take(Math.max(1, Math.min(args.limit ?? 6, 12)));
    const result = [];
    for (const featured of rows) {
      const thread = await ctx.db.get("threads", featured.threadId);
      if (thread === null || thread.board !== "projects" || thread.status !== "published" || thread.hiddenAt !== undefined || !isSafetyApproved(thread.moderationStatus)) continue;
      const profile = await getProfile(ctx, thread.authorId);
      const metadata = await ctx.db.query("projectMetadata").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).order("asc").take(6);
      const tagRows = await ctx.db.query("projectTags").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).order("asc").take(MAX_PROJECT_TAGS);
      const imageUrl = thread.imageStorageId === undefined ? null : await ctx.storage.getUrl(thread.imageStorageId);
      result.push({
        ...thread,
        authorHandle: profile?.handle ?? "unknown",
        metadata,
        tags: tagRows.map((row) => row.tag),
        imageUrl,
        featureOrder: featured.order,
      });
    }
    return result;
  },
});

export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 4, 12));
    const boards = ["projects", "ideas", "tech", "general"] as const;
    const groups = await Promise.all(
      boards.map((board) =>
        ctx.db
          .query("threads")
          .withIndex("by_board_and_status", (q) => q.eq("board", board).eq("status", "published"))
          .order("desc")
          .take(Math.min(limit * 2, 24)),
      ),
    );
    const rows = groups
      .flat()
      .filter((thread) => thread.hiddenAt === undefined && isSafetyApproved(thread.moderationStatus))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, limit);
    return await Promise.all(
      rows.map(async (thread) => {
        const profile = await getProfile(ctx, thread.authorId);
        return { ...thread, authorHandle: profile?.handle ?? "unknown" };
      }),
    );
  },
});

export const getThread = query({
  args: { threadId: v.id("threads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get("threads", args.threadId);
    if (thread === null) return null;
    const viewerId = await getCurrentUserId(ctx);
    const viewerProfile = viewerId === null ? null : await getProfile(ctx, viewerId);
    const canModerate = viewerProfile?.role === "moderator";
    if (thread.status === "draft" && thread.authorId !== viewerId && !canModerate) return null;
    if (!isSafetyApproved(thread.moderationStatus) && thread.authorId !== viewerId && !canModerate) return null;
    const safetyApproved = isSafetyApproved(thread.moderationStatus);
    const author = await getProfile(ctx, thread.authorId);
    const metadata = safetyApproved
      ? await ctx.db.query("projectMetadata").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).order("asc").take(6)
      : [];
    const tagRows = safetyApproved
      ? await ctx.db.query("projectTags").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).order("asc").take(MAX_PROJECT_TAGS)
      : [];
    const imageUrl = safetyApproved && thread.imageStorageId !== undefined ? await ctx.storage.getUrl(thread.imageStorageId) : null;
    const replyRows = await ctx.db.query("replies").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).order("asc").take(200);
    const visibleReplies = replyRows.filter((replyDoc) => isSafetyApproved(replyDoc.moderationStatus) || replyDoc.authorId === viewerId || canModerate);
    const replies = await Promise.all(visibleReplies.map(async (replyDoc) => {
      const profile = await getProfile(ctx, replyDoc.authorId);
      return {
        ...replyDoc,
        body: replyDoc.hiddenAt
          ? "[reply removed by moderator]"
          : isSafetyApproved(replyDoc.moderationStatus)
            ? replyDoc.body
            : "",
        authorHandle: profile?.handle ?? "unknown",
        canEdit: replyDoc.authorId === viewerId && replyDoc.hiddenAt === undefined && replyDoc.moderationStatus !== "pending" && replyDoc.moderationStatus !== "error",
        canDelete: replyDoc.authorId === viewerId,
      };
    }));
    const featured = await ctx.db.query("featuredProjects").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).unique();
    return {
      ...thread,
      title: thread.hiddenAt
        ? "[thread removed by moderator]"
        : safetyApproved
          ? thread.title
          : thread.moderationStatus === "pending"
            ? "[awaiting safety check]"
            : thread.moderationStatus === "error"
              ? "[safety check unavailable]"
              : "[removed by automated safety check]",
      body: thread.hiddenAt ? "[This thread was removed by a moderator.]" : safetyApproved ? thread.body : "",
      projectUrl: safetyApproved ? thread.projectUrl : undefined,
      authorHandle: author?.handle ?? "unknown",
      metadata,
      tags: tagRows.map((row) => row.tag),
      imageUrl,
      replies,
      isFeatured: featured !== null,
      canEdit: thread.authorId === viewerId && thread.hiddenAt === undefined && thread.moderationStatus !== "pending" && thread.moderationStatus !== "error",
      canDelete: thread.authorId === viewerId,
      canModerate,
    };
  },
});

export const beginCreateThread = internalMutation({
  args: {
    userId: v.id("users"),
    submissionId: v.string(),
    board: boardValidator,
    status: v.union(v.literal("draft"), v.literal("published")),
    imageStorageId: v.optional(v.id("_storage")),
  },
  returns: beginThreadModerationResultValidator,
  handler: async (ctx, args) => {
    await requireMemberById(ctx, args.userId);
    if (args.board !== "projects" && args.imageStorageId !== undefined) {
      throw new Error("Only project threads can have images.");
    }
    const existing = await getAttemptBySubmissionId(ctx, args.submissionId);
    if (existing !== null) {
      assertAttemptMatches(existing, args.userId, "threadCreate");
      if (existing.threadId === undefined) throw new Error("Submission record is incomplete.");
      if (existing.status === "approved" || existing.status === "rejected") {
        if (args.imageStorageId !== undefined && args.imageStorageId !== existing.imageStorageId) {
          await deleteProjectImageIfPresent(ctx, args.imageStorageId);
        }
        return { state: "complete", threadId: existing.threadId, status: existing.status } as const;
      }
      if (existing.status === "pending") {
        if (args.imageStorageId !== undefined && args.imageStorageId !== existing.imageStorageId) {
          await deleteProjectImageIfPresent(ctx, args.imageStorageId);
        }
        return { state: "pending", threadId: existing.threadId } as const;
      }
      const thread = await ctx.db.get("threads", existing.threadId);
      if (thread === null) throw new Error("The failed submission no longer exists.");
      if (thread.board !== args.board) throw new Error("That submission identifier belongs to another board.");
      await validateProjectImage(ctx, args.imageStorageId);
      const imageUrl = args.imageStorageId === undefined ? null : await ctx.storage.getUrl(args.imageStorageId);
      if (args.imageStorageId !== undefined && imageUrl === null) throw new Error("That project image was not found.");
      if (existing.imageStorageId !== undefined && existing.imageStorageId !== args.imageStorageId) {
        await deleteProjectImageIfPresent(ctx, existing.imageStorageId);
      }
      const revision = (thread.moderationRevision ?? 0) + 1;
      const attemptCount = existing.attemptCount + 1;
      await ctx.db.patch("threads", thread._id, {
        title: "[awaiting safety check]",
        body: "",
        imageStorageId: undefined,
        projectUrl: undefined,
        moderationStatus: "pending",
        moderationRevision: revision,
        moderationModel: undefined,
        moderationCheckedAt: undefined,
        moderationCategories: undefined,
      });
      await ctx.db.patch("moderationAttempts", existing._id, {
        status: "pending",
        attemptCount,
        targetRevision: revision,
        updatedAt: Date.now(),
        imageStorageId: args.imageStorageId,
        errorCode: undefined,
      });
      await scheduleAttemptExpiry(ctx, existing._id, attemptCount);
      return {
        state: "ready",
        attemptId: existing._id,
        attemptCount,
        threadId: thread._id,
        revision,
        imageUrl,
        board: thread.board,
      } as const;
    }
    await validateProjectImage(ctx, args.imageStorageId);
    const imageUrl = args.imageStorageId === undefined ? null : await ctx.storage.getUrl(args.imageStorageId);
    if (args.imageStorageId !== undefined && imageUrl === null) throw new Error("That project image was not found.");
    const revision = 1;
    const now = Date.now();
    const threadId = await ctx.db.insert("threads", {
      board: args.board,
      title: "[awaiting safety check]",
      body: "",
      authorId: args.userId,
      status: args.board === "projects" ? args.status : "published",
      replyCount: 0,
      lastActivityAt: now,
      moderationStatus: "pending",
      moderationRevision: revision,
    });
    const attemptId = await ctx.db.insert("moderationAttempts", {
      submissionId: args.submissionId,
      userId: args.userId,
      kind: "threadCreate",
      threadId,
      status: "pending",
      attemptCount: 1,
      targetRevision: revision,
      updatedAt: now,
      ...(args.imageStorageId === undefined ? {} : { imageStorageId: args.imageStorageId }),
    });
    await scheduleAttemptExpiry(ctx, attemptId, 1);
    return {
      state: "ready",
      attemptId,
      attemptCount: 1,
      threadId,
      revision,
      imageUrl,
      board: args.board,
    } as const;
  },
});

export const beginThreadEdit = internalMutation({
  args: {
    userId: v.id("users"),
    submissionId: v.string(),
    threadId: v.id("threads"),
    imageStorageId: v.optional(v.id("_storage")),
    removeImage: v.boolean(),
  },
  returns: beginThreadModerationResultValidator,
  handler: async (ctx, args) => {
    await requireMemberById(ctx, args.userId);
    const existing = await getAttemptBySubmissionId(ctx, args.submissionId);
    if (existing !== null) {
      assertAttemptMatches(existing, args.userId, "threadEdit", { threadId: args.threadId });
      if (existing.status === "approved" || existing.status === "rejected") {
        if (args.imageStorageId !== undefined && args.imageStorageId !== existing.imageStorageId) {
          await deleteProjectImageIfPresent(ctx, args.imageStorageId);
        }
        return { state: "complete", threadId: args.threadId, status: existing.status } as const;
      }
      if (existing.status === "pending") {
        if (args.imageStorageId !== undefined && args.imageStorageId !== existing.imageStorageId) {
          await deleteProjectImageIfPresent(ctx, args.imageStorageId);
        }
        return { state: "pending", threadId: args.threadId } as const;
      }
    }
    const thread = await ctx.db.get("threads", args.threadId);
    if (thread === null) throw new Error("Thread not found.");
    if (thread.authorId !== args.userId) throw new Error("You can only edit your own threads.");
    if (thread.hiddenAt !== undefined) throw new Error("A hidden thread cannot be edited.");
    if (thread.moderationStatus === "pending") throw new Error("This thread is already being checked.");
    if (args.imageStorageId !== undefined && args.removeImage) {
      throw new Error("Choose a replacement image or remove the current one, not both.");
    }
    if (thread.board !== "projects" && (args.imageStorageId !== undefined || args.removeImage)) {
      throw new Error("Only project threads can have images.");
    }
    await validateProjectImage(ctx, args.imageStorageId);
    const imageToCheck = args.imageStorageId ?? (args.removeImage ? undefined : thread.imageStorageId);
    const imageUrl = imageToCheck === undefined ? null : await ctx.storage.getUrl(imageToCheck);
    if (imageToCheck !== undefined && imageUrl === null) throw new Error("That project image was not found.");
    const previousStatus = thread.moderationStatus ?? "approved";
    const revision = (thread.moderationRevision ?? 0) + 1;
    const attemptCount = existing === null ? 1 : existing.attemptCount + 1;
    const now = Date.now();
    await ctx.db.patch("threads", thread._id, { moderationStatus: "pending", moderationRevision: revision });
    const attemptId = existing === null
      ? await ctx.db.insert("moderationAttempts", {
        submissionId: args.submissionId,
        userId: args.userId,
        kind: "threadEdit",
        threadId: thread._id,
        status: "pending",
        attemptCount,
        targetRevision: revision,
        updatedAt: now,
        previousStatus,
        ...(args.imageStorageId === undefined ? {} : { imageStorageId: args.imageStorageId }),
        removeImage: args.removeImage,
      })
      : existing._id;
    if (existing !== null) {
      if (existing.imageStorageId !== undefined && existing.imageStorageId !== args.imageStorageId) {
        await deleteProjectImageIfPresent(ctx, existing.imageStorageId);
      }
      await ctx.db.patch("moderationAttempts", existing._id, {
        status: "pending",
        attemptCount,
        targetRevision: revision,
        updatedAt: now,
        previousStatus,
        imageStorageId: args.imageStorageId,
        removeImage: args.removeImage,
        errorCode: undefined,
      });
    }
    await scheduleAttemptExpiry(ctx, attemptId, attemptCount);
    return {
      state: "ready",
      attemptId,
      attemptCount,
      threadId: thread._id,
      revision,
      imageUrl,
      board: thread.board,
    } as const;
  },
});

export const finishThreadModeration = internalMutation({
  args: {
    attemptId: v.id("moderationAttempts"),
    attemptCount: v.number(),
    threadId: v.id("threads"),
    revision: v.number(),
    flagged: v.boolean(),
    categories: v.array(v.string()),
    model: v.string(),
    safeContent: v.optional(approvedThreadContentValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get("moderationAttempts", args.attemptId);
    const thread = await ctx.db.get("threads", args.threadId);
    if (
      attempt === null ||
      attempt.threadId !== args.threadId ||
      attempt.status !== "pending" ||
      attempt.attemptCount !== args.attemptCount ||
      attempt.targetRevision !== args.revision ||
      thread === null ||
      thread.moderationStatus !== "pending" ||
      thread.moderationRevision !== args.revision
    ) {
      return false;
    }
    const candidateImageStorageId = attempt.imageStorageId;
    const removeImage = attempt.removeImage ?? false;
    const checkedAt = Date.now();
    if (args.flagged) {
      await replaceProjectDetails(ctx, thread._id, [], []);
      const featured = await ctx.db.query("featuredProjects")
        .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
        .unique();
      if (featured !== null) await ctx.db.delete("featuredProjects", featured._id);
      if (thread.imageStorageId !== undefined) await deleteProjectImageIfPresent(ctx, thread.imageStorageId);
      if (candidateImageStorageId !== undefined && candidateImageStorageId !== thread.imageStorageId) {
        await deleteProjectImageIfPresent(ctx, candidateImageStorageId);
      }
      await ctx.db.patch("threads", thread._id, {
        title: "[removed by automated safety check]",
        body: "",
        imageStorageId: undefined,
        projectUrl: undefined,
        moderationStatus: "rejected",
        moderationModel: args.model,
        moderationCheckedAt: checkedAt,
        moderationCategories: args.categories,
      });
      await ctx.db.patch("moderationAttempts", attempt._id, {
        status: "rejected",
        updatedAt: checkedAt,
        imageStorageId: undefined,
        errorCode: undefined,
      });
      return true;
    }
    if (args.safeContent === undefined) throw new Error("Approved moderation requires safe content.");
    const nextImageStorageId = candidateImageStorageId ?? (removeImage ? undefined : thread.imageStorageId);
    if (thread.imageStorageId !== undefined && thread.imageStorageId !== nextImageStorageId) {
      await deleteProjectImageIfPresent(ctx, thread.imageStorageId);
    }
    await ctx.db.patch("threads", thread._id, {
      title: args.safeContent.title,
      body: args.safeContent.body,
      ...(thread.board === "projects" ? {
        projectUrl: args.safeContent.projectUrl,
        imageStorageId: nextImageStorageId,
      } : {}),
      moderationStatus: "approved",
      moderationModel: args.model,
      moderationCheckedAt: checkedAt,
      moderationCategories: [],
    });
    if (thread.board === "projects") {
      await replaceProjectDetails(ctx, thread._id, args.safeContent.metadata, args.safeContent.tags);
    }
    await ctx.db.patch("moderationAttempts", attempt._id, {
      status: "approved",
      updatedAt: checkedAt,
      imageStorageId: undefined,
      errorCode: undefined,
    });
    return true;
  },
});

export const markModerationAttemptError = internalMutation({
  args: {
    attemptId: v.id("moderationAttempts"),
    attemptCount: v.number(),
    errorCode: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get("moderationAttempts", args.attemptId);
    if (attempt === null || attempt.status !== "pending" || attempt.attemptCount !== args.attemptCount) return false;
    await setAttemptError(ctx, attempt, args.errorCode);
    return true;
  },
});

export const expireModerationAttempt = internalMutation({
  args: { attemptId: v.id("moderationAttempts"), attemptCount: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get("moderationAttempts", args.attemptId);
    if (attempt !== null && attempt.status === "pending" && attempt.attemptCount === args.attemptCount) {
      await setAttemptError(ctx, attempt, "watchdog_timeout");
    }
    return null;
  },
});

export const beginCreateReply = internalMutation({
  args: { userId: v.id("users"), submissionId: v.string(), threadId: v.id("threads") },
  returns: beginReplyModerationResultValidator,
  handler: async (ctx, args) => {
    const profile = await requireMemberById(ctx, args.userId);
    const existing = await getAttemptBySubmissionId(ctx, args.submissionId);
    if (existing !== null) {
      assertAttemptMatches(existing, args.userId, "replyCreate", { threadId: args.threadId });
      if (existing.replyId === undefined) throw new Error("Submission record is incomplete.");
      if (existing.status === "approved" || existing.status === "rejected") {
        return { state: "complete", replyId: existing.replyId, status: existing.status } as const;
      }
      if (existing.status === "pending") return { state: "pending", replyId: existing.replyId } as const;
    }
    const thread = await ctx.db.get("threads", args.threadId);
    if (thread === null) throw new Error("Thread not found.");
    if (thread.hiddenAt !== undefined || !isSafetyApproved(thread.moderationStatus)) throw new Error("This thread is closed.");
    if (thread.status === "draft" && thread.authorId !== args.userId && profile.role !== "moderator") throw new Error("This draft is private.");
    const existingReply = existing?.replyId === undefined ? null : await ctx.db.get("replies", existing.replyId);
    const revision = existingReply === null ? 1 : (existingReply.moderationRevision ?? 0) + 1;
    const attemptCount = existing === null ? 1 : existing.attemptCount + 1;
    const replyId = existingReply === null
      ? await ctx.db.insert("replies", {
        threadId: thread._id,
        authorId: args.userId,
        body: "",
        moderationStatus: "pending",
        moderationRevision: revision,
      })
      : existingReply._id;
    if (existingReply !== null) {
      await ctx.db.patch("replies", existingReply._id, {
        body: "",
        moderationStatus: "pending",
        moderationRevision: revision,
        moderationModel: undefined,
        moderationCheckedAt: undefined,
        moderationCategories: undefined,
      });
    }
    const now = Date.now();
    const attemptId = existing === null
      ? await ctx.db.insert("moderationAttempts", {
        submissionId: args.submissionId,
        userId: args.userId,
        kind: "replyCreate",
        threadId: thread._id,
        replyId,
        status: "pending",
        attemptCount,
        targetRevision: revision,
        updatedAt: now,
      })
      : existing._id;
    if (existing !== null) {
      await ctx.db.patch("moderationAttempts", existing._id, {
        status: "pending",
        attemptCount,
        targetRevision: revision,
        updatedAt: now,
        errorCode: undefined,
      });
    }
    await scheduleAttemptExpiry(ctx, attemptId, attemptCount);
    return { state: "ready", attemptId, attemptCount, replyId, revision } as const;
  },
});

export const beginReplyEdit = internalMutation({
  args: { userId: v.id("users"), submissionId: v.string(), replyId: v.id("replies") },
  returns: beginReplyModerationResultValidator,
  handler: async (ctx, args) => {
    await requireMemberById(ctx, args.userId);
    const existing = await getAttemptBySubmissionId(ctx, args.submissionId);
    if (existing !== null) {
      assertAttemptMatches(existing, args.userId, "replyEdit", { replyId: args.replyId });
      if (existing.status === "approved" || existing.status === "rejected") {
        return { state: "complete", replyId: args.replyId, status: existing.status } as const;
      }
      if (existing.status === "pending") return { state: "pending", replyId: args.replyId } as const;
    }
    const replyDoc = await ctx.db.get("replies", args.replyId);
    if (replyDoc === null) throw new Error("Reply not found.");
    if (replyDoc.authorId !== args.userId) throw new Error("You can only edit your own replies.");
    if (replyDoc.hiddenAt !== undefined) throw new Error("A hidden reply cannot be edited.");
    if (replyDoc.moderationStatus === "pending") throw new Error("This reply is already being checked.");
    const thread = await ctx.db.get("threads", replyDoc.threadId);
    if (thread === null || thread.hiddenAt !== undefined || !isSafetyApproved(thread.moderationStatus)) {
      throw new Error("This thread is no longer available.");
    }
    const previousStatus = replyDoc.moderationStatus ?? "approved";
    const revision = (replyDoc.moderationRevision ?? 0) + 1;
    const attemptCount = existing === null ? 1 : existing.attemptCount + 1;
    const now = Date.now();
    await ctx.db.patch("replies", replyDoc._id, { moderationStatus: "pending", moderationRevision: revision });
    if (isSafetyApproved(previousStatus)) {
      await ctx.db.patch("threads", thread._id, {
        replyCount: Math.max(0, thread.replyCount - 1),
        lastActivityAt: await latestApprovedReplyTime(ctx, thread._id, thread._creationTime),
      });
    }
    const attemptId = existing === null
      ? await ctx.db.insert("moderationAttempts", {
        submissionId: args.submissionId,
        userId: args.userId,
        kind: "replyEdit",
        threadId: thread._id,
        replyId: replyDoc._id,
        status: "pending",
        attemptCount,
        targetRevision: revision,
        updatedAt: now,
        previousStatus,
      })
      : existing._id;
    if (existing !== null) {
      await ctx.db.patch("moderationAttempts", existing._id, {
        status: "pending",
        attemptCount,
        targetRevision: revision,
        updatedAt: now,
        previousStatus,
        errorCode: undefined,
      });
    }
    await scheduleAttemptExpiry(ctx, attemptId, attemptCount);
    return { state: "ready", attemptId, attemptCount, replyId: replyDoc._id, revision } as const;
  },
});

export const finishReplyModeration = internalMutation({
  args: {
    attemptId: v.id("moderationAttempts"),
    attemptCount: v.number(),
    replyId: v.id("replies"),
    revision: v.number(),
    flagged: v.boolean(),
    categories: v.array(v.string()),
    model: v.string(),
    safeBody: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get("moderationAttempts", args.attemptId);
    const replyDoc = await ctx.db.get("replies", args.replyId);
    if (
      attempt === null ||
      attempt.replyId !== args.replyId ||
      attempt.status !== "pending" ||
      attempt.attemptCount !== args.attemptCount ||
      attempt.targetRevision !== args.revision ||
      replyDoc === null ||
      replyDoc.moderationStatus !== "pending" ||
      replyDoc.moderationRevision !== args.revision
    ) return false;
    const checkedAt = Date.now();
    if (args.flagged) {
      await ctx.db.patch("replies", replyDoc._id, {
        body: "",
        moderationStatus: "rejected",
        moderationModel: args.model,
        moderationCheckedAt: checkedAt,
        moderationCategories: args.categories,
      });
      await ctx.db.patch("moderationAttempts", attempt._id, {
        status: "rejected",
        updatedAt: checkedAt,
        errorCode: undefined,
      });
      return true;
    }
    if (args.safeBody === undefined) throw new Error("Approved moderation requires safe reply content.");
    await ctx.db.patch("replies", replyDoc._id, {
      body: args.safeBody,
      moderationStatus: "approved",
      moderationModel: args.model,
      moderationCheckedAt: checkedAt,
      moderationCategories: [],
    });
    const thread = await ctx.db.get("threads", replyDoc.threadId);
    if (thread !== null) {
      await ctx.db.patch("threads", thread._id, {
        replyCount: thread.replyCount + 1,
        lastActivityAt: Math.max(thread.lastActivityAt, replyDoc._creationTime),
      });
    }
    await ctx.db.patch("moderationAttempts", attempt._id, {
      status: "approved",
      updatedAt: checkedAt,
      errorCode: undefined,
    });
    return true;
  },
});

export const deleteReply = mutation({
  args: { replyId: v.id("replies") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { userId } = await requireMember(ctx);
    const replyDoc = await ctx.db.get("replies", args.replyId);
    if (replyDoc === null) throw new Error("Reply not found.");
    if (replyDoc.authorId !== userId) throw new Error("You can only delete your own replies.");
    const thread = await ctx.db.get("threads", replyDoc.threadId);
    const attempts = await ctx.db
      .query("moderationAttempts")
      .withIndex("by_replyId", (q) => q.eq("replyId", replyDoc._id))
      .take(20);
    for (const attempt of attempts) {
      if (attempt.imageStorageId !== undefined) await deleteProjectImageIfPresent(ctx, attempt.imageStorageId);
      await ctx.db.delete("moderationAttempts", attempt._id);
    }
    await ctx.db.delete("replies", replyDoc._id);
    if (thread !== null && isSafetyApproved(replyDoc.moderationStatus)) {
      await ctx.db.patch("threads", thread._id, {
        replyCount: Math.max(0, thread.replyCount - 1),
        lastActivityAt: await latestApprovedReplyTime(ctx, thread._id, thread._creationTime),
      });
    }
    return null;
  },
});

export const deleteThread = mutation({
  args: { threadId: v.id("threads") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { userId } = await requireMember(ctx);
    const thread = await ctx.db.get("threads", args.threadId);
    if (thread === null) throw new Error("Thread not found.");
    if (thread.authorId !== userId) throw new Error("You can only delete your own threads.");

    const metadata = await ctx.db.query("projectMetadata").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).take(7);
    const tags = await ctx.db.query("projectTags").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).take(MAX_PROJECT_TAGS + 1);
    const featured = await ctx.db.query("featuredProjects").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).unique();
    const replies = await ctx.db.query("replies").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).take(100);
    const attempts = await ctx.db.query("moderationAttempts").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).take(100);
    for (const item of metadata) await ctx.db.delete("projectMetadata", item._id);
    for (const item of tags) await ctx.db.delete("projectTags", item._id);
    for (const item of replies) await ctx.db.delete("replies", item._id);
    for (const attempt of attempts) {
      if (attempt.imageStorageId !== undefined) await deleteProjectImageIfPresent(ctx, attempt.imageStorageId);
      await ctx.db.delete("moderationAttempts", attempt._id);
    }
    if (featured !== null) await ctx.db.delete("featuredProjects", featured._id);
    if (thread.imageStorageId !== undefined) await deleteProjectImageIfPresent(ctx, thread.imageStorageId);
    await ctx.db.delete("threads", thread._id);
    if (replies.length === 100 || attempts.length === 100) {
      await ctx.scheduler.runAfter(0, internal.forum.cleanupDeletedThreadReplies, { threadId: thread._id });
    }
    return null;
  },
});

export const cleanupDeletedThreadReplies = internalMutation({
  args: { threadId: v.id("threads") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const replies = await ctx.db.query("replies").withIndex("by_threadId", (q) => q.eq("threadId", args.threadId)).take(100);
    const attempts = await ctx.db.query("moderationAttempts").withIndex("by_threadId", (q) => q.eq("threadId", args.threadId)).take(100);
    for (const item of replies) await ctx.db.delete("replies", item._id);
    for (const attempt of attempts) {
      if (attempt.imageStorageId !== undefined) await deleteProjectImageIfPresent(ctx, attempt.imageStorageId);
      await ctx.db.delete("moderationAttempts", attempt._id);
    }
    if (replies.length === 100 || attempts.length === 100) {
      await ctx.scheduler.runAfter(0, internal.forum.cleanupDeletedThreadReplies, args);
    }
    return null;
  },
});

export const setProjectStatus = mutation({
  args: { threadId: v.id("threads"), status: v.union(v.literal("draft"), v.literal("published")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { userId, profile } = await requireMember(ctx);
    const thread = await ctx.db.get("threads", args.threadId);
    if (thread === null || thread.board !== "projects") throw new Error("Project thread not found.");
    if (thread.authorId !== userId && profile.role !== "moderator") throw new Error("You cannot edit this project.");
    await ctx.db.patch("threads", thread._id, { status: args.status });
    if (args.status === "draft") {
      const featured = await ctx.db.query("featuredProjects").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).unique();
      if (featured !== null) await ctx.db.delete("featuredProjects", featured._id);
    }
    return null;
  },
});

export const setFeatured = mutation({
  args: { threadId: v.id("threads"), featured: v.boolean(), order: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { userId } = await requireModerator(ctx);
    const thread = await ctx.db.get("threads", args.threadId);
    if (thread === null || thread.board !== "projects" || thread.status !== "published" || thread.hiddenAt !== undefined || !isSafetyApproved(thread.moderationStatus)) throw new Error("Only visible, published projects can be featured.");
    const existing = await ctx.db.query("featuredProjects").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).unique();
    if (!args.featured && existing !== null) await ctx.db.delete("featuredProjects", existing._id);
    if (args.featured && existing === null) await ctx.db.insert("featuredProjects", { threadId: thread._id, order: Math.max(0, Math.floor(args.order)), featuredBy: userId, featuredAt: Date.now() });
    if (args.featured && existing !== null) await ctx.db.patch("featuredProjects", existing._id, { order: Math.max(0, Math.floor(args.order)) });
    return null;
  },
});

export const moderate = mutation({
  args: { targetType: v.union(v.literal("thread"), v.literal("reply")), threadId: v.optional(v.id("threads")), replyId: v.optional(v.id("replies")), action: v.union(v.literal("hide"), v.literal("restore")), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { userId } = await requireModerator(ctx);
    const reason = args.reason.trim().slice(0, 280);
    if (!reason) throw new Error("Add a short moderation reason.");
    const hiddenAt = args.action === "hide" ? Date.now() : undefined;
    const hiddenBy = args.action === "hide" ? userId : undefined;
    let targetId: string;
    if (args.targetType === "thread") {
      if (args.threadId === undefined) throw new Error("Missing thread.");
      const thread = await ctx.db.get("threads", args.threadId);
      if (thread === null) throw new Error("Thread not found.");
      await ctx.db.patch("threads", thread._id, { hiddenAt, hiddenBy });
      if (args.action === "hide") {
        const featured = await ctx.db.query("featuredProjects").withIndex("by_threadId", (q) => q.eq("threadId", thread._id)).unique();
        if (featured !== null) await ctx.db.delete("featuredProjects", featured._id);
      }
      targetId = thread._id;
    } else {
      if (args.replyId === undefined) throw new Error("Missing reply.");
      const replyDoc = await ctx.db.get("replies", args.replyId);
      if (replyDoc === null) throw new Error("Reply not found.");
      await ctx.db.patch("replies", replyDoc._id, { hiddenAt, hiddenBy });
      targetId = replyDoc._id;
    }
    await ctx.db.insert("moderationLog", { moderatorId: userId, targetType: args.targetType, targetId, action: args.action, reason });
    return null;
  },
});

export const listModerationLog = query({
  args: { limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (userId === null) return [];
    const profile = await getProfile(ctx, userId);
    if (profile?.role !== "moderator") return [];
    return await ctx.db.query("moderationLog").withIndex("by_moderatorId", (q) => q.eq("moderatorId", userId)).order("desc").take(Math.max(1, Math.min(args.limit ?? 30, 50)));
  },
});
