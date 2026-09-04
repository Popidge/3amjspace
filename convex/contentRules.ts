import { v } from "convex/values";

export const boardValidator = v.union(
  v.literal("projects"),
  v.literal("ideas"),
  v.literal("tech"),
  v.literal("general"),
);

export const metadataValidator = v.object({ key: v.string(), value: v.string() });

export const MAX_PROJECT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PROJECT_TAGS = 5;

export function normalizeSubmissionId(value: string) {
  const submissionId = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(submissionId)) {
    throw new Error("Invalid submission identifier.");
  }
  return submissionId;
}

export type Board = "projects" | "ideas" | "tech" | "general";
export type ProjectMetadataInput = { key: string; value: string };

export type ThreadContentInput = {
  board: Board;
  title: string;
  body: string;
  metadata: ProjectMetadataInput[];
  projectUrl?: string;
  tags?: string[];
  imageAltText?: string;
};

export type NormalizedThreadContent = {
  title: string;
  body: string;
  metadata: ProjectMetadataInput[];
  projectUrl?: string;
  tags: string[];
  imageAltText?: string;
};

function normalizeProjectUrl(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 2048) {
    throw new Error("Project links must be 2,048 characters or fewer.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Project links must be valid HTTP or HTTPS URLs.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Project links must use HTTP or HTTPS.");
  }
  return parsed.toString();
}

function normalizeProjectTags(values: string[] | undefined) {
  if ((values?.length ?? 0) > MAX_PROJECT_TAGS) {
    throw new Error("Projects can have up to five tags.");
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const tag = value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
    if (tag.length < 2 || tag.length > 24) {
      throw new Error("Project tags must be 2–24 characters.");
    }
    if (!seen.has(tag)) {
      tags.push(tag);
      seen.add(tag);
    }
  }
  return tags;
}

export function normalizeThreadContent(input: ThreadContentInput): NormalizedThreadContent {
  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length < 3 || title.length > 100) {
    throw new Error("Thread titles must be 3–100 characters.");
  }
  if (body.length < 3 || body.length > 12000) {
    throw new Error("Posts must be 3–12,000 characters.");
  }
  if (input.metadata.length > 6) {
    throw new Error("Projects can have up to six metadata fields.");
  }
  const metadata = input.metadata
    .map((item) => ({ key: item.key.trim().slice(0, 32), value: item.value.trim().slice(0, 160) }))
    .filter((item) => item.key && item.value);
  const projectUrl = normalizeProjectUrl(input.projectUrl);
  const tags = normalizeProjectTags(input.tags);
  const imageAltText = input.imageAltText?.trim().slice(0, 280) || undefined;
  if (input.board !== "projects" && (metadata.length > 0 || projectUrl !== undefined || tags.length > 0 || imageAltText !== undefined)) {
    throw new Error("Only project threads can have links, tags, or project details.");
  }
  return { title, body, metadata, projectUrl, tags, imageAltText };
}

export function normalizeReplyBody(value: string) {
  const body = value.trim();
  if (body.length < 2 || body.length > 8000) {
    throw new Error("Replies must be 2–8,000 characters.");
  }
  return body;
}

export function buildThreadModerationText(content: NormalizedThreadContent) {
  const parts = [`Thread title:\n${content.title}`, `Post:\n${content.body}`];
  if (content.projectUrl) parts.push(`Project link:\n${content.projectUrl}`);
  if (content.imageAltText) parts.push(`Project image description:\n${content.imageAltText}`);
  if (content.tags.length > 0) parts.push(`Tags:\n${content.tags.join(", ")}`);
  if (content.metadata.length > 0) {
    parts.push(`Project details:\n${content.metadata.map((item) => `${item.key}: ${item.value}`).join("\n")}`);
  }
  return parts.join("\n\n");
}
