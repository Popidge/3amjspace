import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const board = v.union(
  v.literal("projects"),
  v.literal("ideas"),
  v.literal("tech"),
  v.literal("general"),
);

const moderationStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("error"),
);

const moderationAttemptKind = v.union(
  v.literal("threadCreate"),
  v.literal("threadEdit"),
  v.literal("replyCreate"),
  v.literal("replyEdit"),
);

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"])
    .index("by_email", ["email"]),
  profiles: defineTable({
    userId: v.id("users"),
    handle: v.string(),
    bio: v.string(),
    displayName: v.optional(v.string()),
    avatarStorageId: v.optional(v.id("_storage")),
    githubUrl: v.optional(v.string()),
    role: v.union(v.literal("member"), v.literal("moderator")),
    status: v.union(v.literal("active"), v.literal("suspended")),
  })
    .index("by_userId", ["userId"])
    .index("by_handle", ["handle"])
    .index("by_role", ["role"]),
  profileLinks: defineTable({
    profileId: v.id("profiles"),
    label: v.string(),
    url: v.string(),
    order: v.number(),
  }).index("by_profileId", ["profileId"]),
  threads: defineTable({
    board,
    slug: v.optional(v.string()),
    title: v.string(),
    body: v.string(),
    authorId: v.id("users"),
    status: v.union(v.literal("draft"), v.literal("published")),
    imageStorageId: v.optional(v.id("_storage")),
    imageAltText: v.optional(v.string()),
    projectUrl: v.optional(v.string()),
    replyCount: v.number(),
    lastActivityAt: v.number(),
    hiddenAt: v.optional(v.number()),
    hiddenBy: v.optional(v.id("users")),
    moderationStatus: v.optional(moderationStatus),
    moderationRevision: v.optional(v.number()),
    moderationModel: v.optional(v.string()),
    moderationCheckedAt: v.optional(v.number()),
    moderationCategories: v.optional(v.array(v.string())),
  })
    .index("by_slug", ["slug"])
    .index("by_board", ["board"])
    .index("by_board_and_status", ["board", "status"])
    .index("by_authorId", ["authorId"]),
  projectMetadata: defineTable({
    threadId: v.id("threads"),
    key: v.string(),
    value: v.string(),
    order: v.number(),
  }).index("by_threadId", ["threadId"]),
  projectTags: defineTable({
    threadId: v.id("threads"),
    tag: v.string(),
    order: v.number(),
  })
    .index("by_threadId", ["threadId"])
    .index("by_tag_and_threadId", ["tag", "threadId"]),
  replies: defineTable({
    threadId: v.id("threads"),
    authorId: v.id("users"),
    body: v.string(),
    hiddenAt: v.optional(v.number()),
    hiddenBy: v.optional(v.id("users")),
    moderationStatus: v.optional(moderationStatus),
    moderationRevision: v.optional(v.number()),
    moderationModel: v.optional(v.string()),
    moderationCheckedAt: v.optional(v.number()),
    moderationCategories: v.optional(v.array(v.string())),
  }).index("by_threadId", ["threadId"]),
  featuredProjects: defineTable({
    threadId: v.id("threads"),
    order: v.number(),
    featuredBy: v.id("users"),
    featuredAt: v.number(),
  })
    .index("by_order", ["order"])
    .index("by_threadId", ["threadId"]),
  moderationLog: defineTable({
    moderatorId: v.id("users"),
    targetType: v.union(v.literal("thread"), v.literal("reply")),
    targetId: v.string(),
    action: v.union(v.literal("hide"), v.literal("restore")),
    reason: v.string(),
  }).index("by_moderatorId", ["moderatorId"]),
  reports: defineTable({
    reporterId: v.id("users"),
    targetType: v.union(v.literal("thread"), v.literal("reply")),
    targetId: v.string(),
    reason: v.string(),
    status: v.union(v.literal("open"), v.literal("resolved")),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_targetId", ["targetId"])
    .index("by_reporterId_and_targetId", ["reporterId", "targetId"]),
  moderationAttempts: defineTable({
    submissionId: v.string(),
    userId: v.id("users"),
    kind: moderationAttemptKind,
    threadId: v.optional(v.id("threads")),
    replyId: v.optional(v.id("replies")),
    status: moderationStatus,
    attemptCount: v.number(),
    targetRevision: v.number(),
    updatedAt: v.number(),
    previousStatus: v.optional(moderationStatus),
    imageStorageId: v.optional(v.id("_storage")),
    removeImage: v.optional(v.boolean()),
    errorCode: v.optional(v.string()),
  })
    .index("by_submissionId", ["submissionId"])
    .index("by_threadId", ["threadId"])
    .index("by_replyId", ["replyId"]),
});
