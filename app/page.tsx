"use client";

import { useClerk } from "@clerk/nextjs";
import { useAction, useMutation, useQuery, useConvexAuth } from "convex/react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { useDeferredValue, useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft, ArrowUpRight, CircleUserRound, FolderOpen, Lightbulb,
  ImagePlus, Link as LinkIcon, LockKeyhole, LogOut, MessageSquareText, Plus, Shield, Sparkles,
  Check, Flag, Github, Globe, Pencil, TerminalSquare, Trash2, UserRound, Wrench, X,
} from "lucide-react";
import type { Id } from "../convex/_generated/dataModel";
import { api } from "../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ThemeToggle } from "@/components/ThemeToggle";
import { deleteLocalDraft, loadLocalDraft, saveLocalDraft } from "@/lib/localDrafts";

type Board = "projects" | "ideas" | "tech" | "general";
export type AppRoute =
  | { kind: "home" }
  | { kind: "board"; board: Board }
  | { kind: "thread"; id: string; board?: Board }
  | { kind: "profile"; handle: string }
  | { kind: "moderation" }
  | { kind: "rules" }
  | { kind: "privacy" };
type ProfileLink = { _id?: Id<"profileLinks">; label: string; url: string };
type Profile = { handle: string; displayName?: string; bio: string; githubUrl?: string; avatarUrl: string | null; links: ProfileLink[]; role: "member" | "moderator"; status: "active" | "suspended" };
type Viewer = { profile: Profile | null; user: { _id: Id<"users">; email?: string; name?: string } | null } | null;
type ProjectMeta = { _id: Id<"projectMetadata">; key: string; value: string };
type SafetyStatus = "pending" | "approved" | "rejected" | "error";
type ThreadSummary = { _id: Id<"threads">; slug?: string; title: string; status: "draft" | "published"; moderationStatus?: SafetyStatus; authorHandle: string; replyCount: number; lastActivityAt: number };
type ProjectFields = { imageUrl: string | null; imageAltText?: string; projectUrl?: string; tags: string[] };
type FeaturedThread = ThreadSummary & ProjectFields & { body: string; metadata: ProjectMeta[] };
type RecentThread = ThreadSummary & { board: Board };
type ReplyItem = { _id: Id<"replies">; _creationTime: number; authorHandle: string; body: string; hiddenAt?: number; moderationStatus?: SafetyStatus; canEdit: boolean; canDelete: boolean };
type ThreadDetail = ThreadSummary & ProjectFields & { _creationTime: number; board: Board; body: string; authorAvatarUrl: string | null; metadata: ProjectMeta[]; replies: ReplyItem[]; hiddenAt?: number; canEdit: boolean; canDelete: boolean; canModerate: boolean; isFeatured: boolean };
type ModerationItem = { _id: Id<"moderationLog">; _creationTime: number; action: "hide" | "restore"; targetType: "thread" | "reply"; targetId: string; reason: string };
type ReportItem = { _id: Id<"reports">; _creationTime: number; targetType: "thread" | "reply"; targetId: string; reason: string; reporterHandle: string; context: string; threadId: Id<"threads"> | null };
type PublicProfile = { handle: string; displayName?: string; bio: string; githubUrl?: string; avatarUrl: string | null; links: ProfileLink[]; threads: Array<{ _id: Id<"threads">; slug?: string; board: Board; title: string; replyCount: number; lastActivityAt: number }> };

const BOARDS: Array<{ id: Board; title: string; description: string; icon: typeof FolderOpen; accent: string }> = [
  { id: "projects", title: "Projects", description: "Finished, unfinished, and difficult to explain.", icon: FolderOpen, accent: "blue" },
  { id: "ideas", title: "Ideas", description: "Loose thoughts looking for co-conspirators.", icon: Lightbulb, accent: "yellow" },
  { id: "tech", title: "Tech", description: "Tools, techniques, failures, and useful debris.", icon: TerminalSquare, accent: "violet" },
  { id: "general", title: "General", description: "Everything that refuses to fit elsewhere.", icon: MessageSquareText, accent: "coral" },
];

function boardInfo(board: Board) { return BOARDS.find((item) => item.id === board)!; }
function displayDate(timestamp: number) { return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(timestamp); }
function displayTime(timestamp: number) { return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message.replace(/^.*Uncaught Error: /, "") : "Something went sideways."; }
function newSubmissionId() { return crypto.randomUUID(); }

function useSavedDraft<T extends { submissionId: string }>(storageKey: string, initialValue: T) {
  const initialValueRef = useRef(initialValue);
  const [draft, setDraft] = useState(initialValue);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const latestDraftRef = useRef(initialValue);
  const dirtyRef = useRef(false);
  const ready = loadedKey === storageKey;

  useEffect(() => {
    let cancelled = false;
    void loadLocalDraft<T>(storageKey).then((saved) => {
      if (cancelled) return;
      if (saved !== null && typeof saved.submissionId === "string" && saved.submissionId.length > 0) {
        setDraft(saved);
        latestDraftRef.current = saved;
        setRecovered(true);
      } else {
        const fresh = { ...initialValueRef.current, submissionId: newSubmissionId() };
        setDraft(fresh);
        latestDraftRef.current = fresh;
        setRecovered(false);
      }
      dirtyRef.current = false;
      setDirty(false);
      setLoadedKey(storageKey);
    });
    return () => { cancelled = true; };
  }, [storageKey]);

  useEffect(() => {
    if (!ready || !dirty) return;
    const timer = window.setTimeout(() => {
      if (dirtyRef.current) void saveLocalDraft(storageKey, latestDraftRef.current);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, ready, storageKey]);

  useEffect(() => () => {
    if (dirtyRef.current) void saveLocalDraft(storageKey, latestDraftRef.current);
  }, [storageKey]);

  function change(updater: (current: T) => T) {
    setDraft((current) => {
      const next = { ...updater(current), submissionId: newSubmissionId() };
      latestDraftRef.current = next;
      return next;
    });
    dirtyRef.current = true;
    setDirty(true);
  }

  async function clear() {
    dirtyRef.current = false;
    setDirty(false);
    await deleteLocalDraft(storageKey);
    const fresh = { ...initialValueRef.current, submissionId: newSubmissionId() };
    setDraft(fresh);
    latestDraftRef.current = fresh;
    setRecovered(false);
  }

  async function persistNow() {
    await saveLocalDraft(storageKey, latestDraftRef.current);
  }

  return { draft, change, ready, recovered, clear, persistNow };
}

function SafetyBadge({ status }: { status?: SafetyStatus }) {
  if (status === "pending") return <b className="safety-badge">CHECKING</b>;
  if (status === "rejected") return <b className="safety-badge safety-rejected">NOT PUBLISHED</b>;
  if (status === "error") return <b className="safety-badge safety-error">RETRY NEEDED</b>;
  return null;
}

const MARKDOWN_ELEMENTS = ["p", "em", "strong", "a", "code", "pre", "ul", "ol", "li", "blockquote", "br"];
const MARKDOWN_HINTS = [
  { label: "links", example: "[site name](https://example.com)" },
  { label: "emphasis", example: "*italic* or **bold**" },
  { label: "code", example: "`inline code`" },
  { label: "lists", example: "- List item" },
  { label: "quotes", example: "Start the line with >" },
];

function MarkdownBody({ content, className = "" }: { content: string; className?: string }) {
  return <div className={`markdown-body ${className}`}><ReactMarkdown
    allowedElements={MARKDOWN_ELEMENTS}
    unwrapDisallowed
    skipHtml
    components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a> }}
  >{content}</ReactMarkdown></div>;
}

function MarkdownEditor({ value, onChange, rows, placeholder, disabled, id, autoFocus }: { value: string; onChange: (value: string) => void; rows: number; placeholder?: string; disabled?: boolean; id?: string; autoFocus?: boolean }) {
  const [preview, setPreview] = useState(false);
  const helpId = useId();
  return <div className="markdown-editor">
    <div className="markdown-tabs"><button type="button" className={!preview ? "active" : ""} onClick={() => setPreview(false)}>Write</button><button type="button" className={preview ? "active" : ""} onClick={() => setPreview(true)}>Preview</button><div className="markdown-help"><span className="markdown-help-label">Markdown:</span>{MARKDOWN_HINTS.map((hint) => { const hintId = `${helpId}-${hint.label}`; return <span className="markdown-hint" tabIndex={0} aria-describedby={hintId} key={hint.label}>{hint.label}<span className="markdown-tooltip" id={hintId} role="tooltip">{hint.example}</span></span>; })}</div></div>
    {preview ? <div className="markdown-preview">{value.trim() ? <MarkdownBody content={value} /> : <span className="quiet">Nothing to preview yet.</span>}</div> : <Textarea id={id} aria-label={id ? undefined : "Markdown text"} value={value} onChange={(event) => onChange(event.target.value)} rows={rows} placeholder={placeholder} disabled={disabled} autoFocus={autoFocus} />}
  </div>;
}

export default function Home() {
  return <ForumApp route={{ kind: "home" }} />;
}

export function ForumApp({ route }: { route: AppRoute }) {
  const [showProfile, setShowProfile] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const router = useRouter();
  const screen = route;
  const { isAuthenticated, isLoading } = useConvexAuth();
  const viewer = useQuery(api.forum.getViewer) as Viewer | undefined;
  const storeViewer = useMutation(api.forum.storeViewer);
  const { openSignIn, signOut } = useClerk();
  const openThread = (id: Id<"threads">, board?: Board, slug?: string) => {
    const routeKey = slug ?? id;
    router.push(board === "projects" ? `/projects/${routeKey}` : `/threads/${routeKey}`);
  };
  const openBoard = (board: Board) => router.push(`/boards/${board}`);
  const openProfile = (handle: string) => router.push(`/profiles/${encodeURIComponent(handle)}`);
  const profile = viewer?.profile;

  useEffect(() => {
    if (isAuthenticated) void storeViewer();
  }, [isAuthenticated, storeViewer]);

  return (
    <div className="site-shell">
      <header className="masthead">
        <Link className="brand" href="/" aria-label="3AMJ.SPACE home">
          3AMJ.SPACE
        </Link>
        <nav className="main-nav" aria-label="Main navigation">
          {BOARDS.map((board) => <Link key={board.id} className={(screen.kind === "board" || screen.kind === "thread") && screen.board === board.id ? "active" : ""} href={`/boards/${board.id}`}>{board.title}</Link>)}
        </nav>
        <div className="header-tools">
          <Link className={`policy-nav-link${screen.kind === "rules" || screen.kind === "privacy" ? " active" : ""}`} href="/rules">Rules / privacy</Link>
          <ThemeToggle />
          <div className="account-actions">
            {isLoading ? <span className="quiet">checking…</span> : isAuthenticated && profile ? (
              <>
                {profile.role === "moderator" && <Button variant="ghost" size="sm" className="mod-button" onClick={() => router.push("/moderation")}><Shield /> Mod</Button>}
                <Button variant="outline" size="sm" onClick={() => setShowProfile(true)}><CircleUserRound /> @{profile.handle}</Button>
                <Button variant="ghost" size="icon" title="Sign out" onClick={() => void signOut()}><LogOut /></Button>
              </>
            ) : isAuthenticated ? <><span className="quiet">setting up…</span><Button variant="ghost" size="icon" title="Sign out" onClick={() => void signOut()}><LogOut /></Button></> : <Button className="join-button" size="sm" onClick={() => openSignIn()}>Log in / Join</Button>}
          </div>
        </div>
      </header>
      <main className="page-wrap">
        {screen.kind === "home" && <FrontPage openThread={openThread} openBoard={openBoard} />}
        {screen.kind === "board" && <BoardPage board={screen.board} openThread={openThread} onCompose={() => isAuthenticated ? setShowComposer(true) : openSignIn()} />}
        {screen.kind === "thread" && <ThreadPage routeKey={screen.id} viewer={viewer} onBack={() => router.push("/")} onDeleted={() => router.push("/")} onNeedAuth={() => openSignIn()} openProfile={openProfile} />}
        {screen.kind === "profile" && <PublicProfilePage handle={screen.handle} openThread={openThread} />}
        {screen.kind === "moderation" && (profile?.role === "moderator" ? <ModerationPage onBack={() => router.push("/")} /> : <FrontPage openThread={openThread} openBoard={openBoard} />)}
        {screen.kind === "rules" && <PolicyPage active="rules" />}
        {screen.kind === "privacy" && <PolicyPage active="privacy" />}
      </main>
      {isAuthenticated && viewer?.user && !viewer.profile && <ProfileSetup />}
      {showProfile && profile && <ProfileDialog profile={profile} onClose={() => setShowProfile(false)} />}
      {showComposer && screen.kind === "board" && viewer?.profile && viewer.user && <Composer userId={viewer.user._id} board={screen.board} onClose={() => setShowComposer(false)} onCreated={(id, slug) => { setShowComposer(false); openThread(id, screen.board, slug); }} />}
    </div>
  );
}

function FrontPage({ openThread, openBoard }: { openThread: (id: Id<"threads">, board?: Board, slug?: string) => void; openBoard: (board: Board) => void }) {
  const featured = useQuery(api.forum.listFeatured, { limit: 6 }) as FeaturedThread[] | undefined;
  const recent = useQuery(api.forum.listRecent, { limit: 4 }) as RecentThread[] | undefined;
  return <>
    <section className="welcome-panel">
      <span className="welcome-mark" aria-hidden="true">›_</span>
      <div><h1>Welcome to 3AMJ.SPACE</h1><p>A small forum for strange, playful AI projects made simply because someone wanted them to exist.</p></div>
    </section>
    <section className="section-block featured-section">
      <div className="section-heading"><h2>Featured projects</h2><button className="text-link" onClick={() => openBoard("projects")}>View all projects <ArrowUpRight /></button></div>
      <div className="featured-grid">
        {featured === undefined ? <LoadingCards count={6} /> : featured.length === 0 ? <EmptyNote text="The front desk is choosing its first projects." /> : featured.map((thread, index) => (
          <button key={thread._id} className="feature-card" onClick={() => openThread(thread._id, "projects", thread.slug)}>
            <ProjectThumb index={index} imageUrl={thread.imageUrl} title={thread.title} />
            <div className="feature-content">
              <h3>{thread.title}</h3>
              <p>{thread.body}</p>
              {thread.metadata[0] && <span className="project-detail">{thread.metadata[0].key}: {thread.metadata[0].value}</span>}
              {(thread.tags ?? []).length > 0 && <span className="tag-list">{(thread.tags ?? []).slice(0, 3).map((tag) => <i key={tag}>{tag}</i>)}</span>}
              <span className="byline">by @{thread.authorHandle}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
    <section className="section-block recent-section">
      <div className="section-heading"><h2>Recent threads</h2><span className="chronology-label">Newest first · never ranked</span></div>
      <div className="recent-table">
        <div className="recent-labels"><span>Thread</span><span>Board</span><span>Author</span><span>Last post</span><span>Replies</span></div>
        {recent === undefined ? <LoadingCards count={4} /> : recent.length === 0 ? <EmptyNote text="No threads yet." /> : recent.map((thread) => (
          <button className="recent-row" key={thread._id} onClick={() => openThread(thread._id, thread.board, thread.slug)}>
            <span className="recent-title"><MessageSquareText />{thread.title}</span>
            <span className={`board-tag board-${thread.board}`}>{boardInfo(thread.board).title}</span>
            <span>@{thread.authorHandle}</span>
            <time>{displayTime(thread.lastActivityAt)}</time>
            <strong>{thread.replyCount}</strong>
          </button>
        ))}
      </div>
    </section>
  </>;
}

function ProjectThumb({ index, imageUrl, title }: { index: number; imageUrl: string | null; title: string }) {
  return <span className={`project-thumb thumb-${index % 6}`}>{imageUrl ? <Image unoptimized loading="eager" src={imageUrl} alt={`${title} project image`} width={264} height={264} /> : <><i /><i /><i /><i /></>}</span>;
}

function BoardPage({ board, openThread, onCompose }: { board: Board; openThread: (id: Id<"threads">, board?: Board, slug?: string) => void; onCompose: () => void }) {
  const info = boardInfo(board); const Icon = info.icon; const threads = useQuery(api.forum.listBoard, { board, limit: 50 }) as ThreadSummary[] | undefined;
  return <section className="board-page"><div className={`board-banner accent-${info.accent}`}><div><span className="kicker">BOARD 0{BOARDS.findIndex((item) => item.id === board) + 1}</span><h1><Icon />{info.title}</h1><p>{info.description}</p></div><Button className="new-thread-button" onClick={onCompose}><Plus /> NEW THREAD</Button></div><div className="thread-table-label"><span>THREAD</span><span>STARTED BY</span><span>REPLIES</span><span>LAST SIGNAL</span></div><div className="thread-list">{threads === undefined ? <LoadingCards count={4} /> : threads.length === 0 ? <EmptyNote text="No threads here yet. Leave the first strange note." /> : threads.map((thread) => <button key={thread._id} className="thread-row" onClick={() => openThread(thread._id, board, thread.slug)}><div className="thread-title"><span>{thread.status === "draft" ? <LockKeyhole /> : <MessageSquareText />}</span><div><h3>{thread.moderationStatus === "pending" ? "Safety check in progress" : thread.moderationStatus === "error" ? "Safety check unavailable" : thread.moderationStatus === "rejected" ? "Submission removed" : thread.title}</h3>{thread.status === "draft" && <b className="draft-badge">DRAFT</b>}<SafetyBadge status={thread.moderationStatus} /></div></div><span className="thread-author">@{thread.authorHandle}</span><span className="thread-replies">{thread.replyCount}</span><span className="thread-date">{displayDate(thread.lastActivityAt)}</span></button>)}</div><p className="chronology-note">Threads are shown newest first. Replies inside them stay strictly chronological. Nothing here is ranked.</p></section>;
}

function ThreadPage({ routeKey, viewer, onBack, onDeleted, onNeedAuth, openProfile }: { routeKey: string; viewer: Viewer | undefined; onBack: () => void; onDeleted: () => void; onNeedAuth: () => void; openProfile: (handle: string) => void }) {
  const thread = useQuery(api.forum.getThread, { routeKey }) as ThreadDetail | null | undefined;
  const router = useRouter();
  const reply = useAction(api.contentModeration.reply);
  const removeThread = useMutation(api.forum.deleteThread);
  const removeReply = useMutation(api.forum.deleteReply);
  const setStatus = useMutation(api.forum.setProjectStatus);
  const setFeatured = useMutation(api.forum.setFeatured);
  const moderate = useMutation(api.forum.moderate);
  const createReport = useMutation(api.forum.createReport);
  const replyDraftState = useSavedDraft(`reply:${viewer?.user?._id ?? "guest"}:${thread?._id ?? routeKey}`, { submissionId: "", body: "" });
  const [replyError, setReplyError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [editingReplyId, setEditingReplyId] = useState<Id<"replies"> | null>(null);
  const [deletingReplyId, setDeletingReplyId] = useState<Id<"replies"> | null>(null);

  useEffect(() => {
    if (thread?.slug === undefined || thread.slug === routeKey) return;
    router.replace(thread.board === "projects" ? `/projects/${thread.slug}` : `/threads/${thread.slug}`);
  }, [routeKey, router, thread?.board, thread?.slug]);

  if (thread === undefined) return <LoadingCards count={3} />;
  if (thread === null) return <EmptyNote text="This thread is private, missing, or between dimensions." />;
  const threadId = thread._id;
  const info = boardInfo(thread.board);

  async function doReply(event: React.FormEvent) {
    event.preventDefault();
    if (!viewer?.profile) return onNeedAuth();
    await replyDraftState.persistNow();
    setBusy(true);
    setReplyError("");
    try {
      await reply({ submissionId: replyDraftState.draft.submissionId, threadId, body: replyDraftState.draft.body });
      await replyDraftState.clear();
    } catch (err) {
      setReplyError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteOwnThread() {
    if (!window.confirm("Delete this thread and all of its replies? This cannot be undone.")) return;
    setActionError("");
    try {
      await removeThread({ threadId });
      onDeleted();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function deleteOwnReply(replyId: Id<"replies">) {
    if (!window.confirm("Delete this reply? This cannot be undone.")) return;
    setDeletingReplyId(replyId);
    setActionError("");
    try {
      await removeReply({ replyId });
      if (editingReplyId === replyId) setEditingReplyId(null);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setDeletingReplyId(null);
    }
  }

  async function moderateTarget(targetType: "thread" | "reply", targetId: string, hidden: boolean) {
    const reason = window.prompt(`${hidden ? "Restore" : "Hide"} this ${targetType}: add a short reason`);
    if (!reason) return;
    setActionError("");
    try {
      await moderate(targetType === "thread" ? { targetType, threadId, action: hidden ? "restore" : "hide", reason } : { targetType, replyId: targetId as Id<"replies">, action: hidden ? "restore" : "hide", reason });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function reportTarget(targetType: "thread" | "reply", targetId: string) {
    if (!viewer?.profile) return onNeedAuth();
    const reason = window.prompt(`Quietly report this ${targetType}: what should the moderators review?`);
    if (!reason) return;
    setActionError("");
    try {
      await createReport(targetType === "thread" ? { targetType, threadId, reason } : { targetType, replyId: targetId as Id<"replies">, reason });
      window.alert("Report sent privately to the moderators. Thank you.");
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  return <section className="thread-page">
    <button className="back-link" onClick={onBack}><ArrowLeft /> FRONT DESK</button>
    <article className={`original-post accent-${info.accent}`}>
      <div className="post-side">{thread.authorAvatarUrl ? <Image unoptimized className="avatar-shape author-avatar" src={thread.authorAvatarUrl} alt="" width={64} height={64} /> : <div className="avatar-shape">{thread.authorHandle.slice(0, 2).toUpperCase()}</div>}<button className="author-link" onClick={() => openProfile(thread.authorHandle)}>@{thread.authorHandle}</button><span>THREAD STARTER</span></div>
      <div className="post-main">
        <div className="post-meta"><span>{info.title.toUpperCase()}</span><span>{displayDate(thread._creationTime)}</span>{thread.status === "draft" && <b className="draft-badge">PRIVATE DRAFT</b>}<SafetyBadge status={thread.moderationStatus} /></div>
        {thread.moderationStatus === "pending" ? <>
          <h1>Safety check in progress</h1>
          <p className="post-body">This submission is hidden while the automated content-safety check runs.</p>
        </> : thread.moderationStatus === "error" ? <>
          <h1>Safety check unavailable</h1>
          <p className="post-body">No submitted content was stored. Reopen the composer on this device to recover the draft and retry.</p>
        </> : thread.moderationStatus === "rejected" ? <>
          <h1>Submission removed</h1>
          <p className="post-body">The automated content-safety check flagged this submission. Its text, link, metadata, tags, and image were not retained.</p>
        </> : <>
          <h1>{thread.title}</h1>
          {thread.imageUrl && <Image unoptimized className="project-image" src={thread.imageUrl} alt={thread.imageAltText ?? ""} width={1200} height={800} />}
          {thread.tags.length > 0 && <div className="thread-tags">{thread.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
          <MarkdownBody className="post-body" content={thread.body} />
          {thread.projectUrl && <a className="project-link" href={thread.projectUrl} target="_blank" rel="noreferrer"><LinkIcon /> Visit project <ArrowUpRight /></a>}
          {thread.metadata.length > 0 && <dl className="metadata-grid">{thread.metadata.map((item) => <div key={item._id}><dt>{item.key}</dt><dd>{item.value}</dd></div>)}</dl>}
        </>}
        <div className="thread-tools">
          {thread.canEdit && <Button variant="outline" size="sm" onClick={() => setShowEditor(true)}><Pencil /> Edit thread</Button>}
          {thread.canDelete && <Button variant="outline" size="sm" className="danger-action" onClick={() => void deleteOwnThread()}><Trash2 /> Delete thread</Button>}
          {thread.board === "projects" && thread.canEdit && <Button variant="outline" size="sm" onClick={() => void setStatus({ threadId: thread._id, status: thread.status === "draft" ? "published" : "draft" })}>{thread.status === "draft" ? "Publish project" : "Return to draft"}</Button>}
          {thread.canModerate && thread.board === "projects" && thread.status === "published" && <Button variant="outline" size="sm" onClick={() => void setFeatured({ threadId: thread._id, featured: !thread.isFeatured, order: 10 })}>{thread.isFeatured ? "Remove from front page" : "Feature on front page"}</Button>}
          {thread.canModerate && <Button variant="outline" size="sm" onClick={() => void moderateTarget("thread", thread._id, Boolean(thread.hiddenAt))}>{thread.hiddenAt ? "Restore thread" : "Hide thread"}</Button>}
          {!thread.hiddenAt && (thread.moderationStatus === undefined || thread.moderationStatus === "approved") && <Button variant="ghost" size="sm" onClick={() => void reportTarget("thread", thread._id)}><Flag /> Report</Button>}
        </div>
        {actionError && <p className="form-error thread-action-error">{actionError}</p>}
      </div>
    </article>
    <div className="reply-divider"><span>{thread.replies.length} {thread.replies.length === 1 ? "REPLY" : "REPLIES"}</span></div>
    <div className="replies-list">{thread.replies.map((item, index) => <article key={item._id} className="reply-card">
      <div className="reply-number">#{String(index + 1).padStart(2, "0")}</div>
      <div className="reply-copy">
        <div className="reply-meta"><button className="author-link" onClick={() => openProfile(item.authorHandle)}>@{item.authorHandle}</button><span>{displayDate(item._creationTime)}</span></div>
        {editingReplyId === item._id && viewer?.user ? <ReplyEditor userId={viewer.user._id} reply={item} onCancel={() => setEditingReplyId(null)} onSaved={() => setEditingReplyId(null)} /> : <MarkdownBody content={item.moderationStatus === "pending" ? "Safety check in progress. This reply is temporarily hidden." : item.moderationStatus === "error" ? "The safety check was unavailable. No submitted text was stored; the author can recover it on the device where they wrote it." : item.moderationStatus === "rejected" ? "This reply was not published. Its submitted text was not retained." : item.body} />}
        {editingReplyId !== item._id && <div className="reply-actions">
          {item.canEdit && <button className="tiny-action" onClick={() => setEditingReplyId(item._id)}>edit</button>}
          {item.canDelete && <button className="tiny-action danger-text" disabled={deletingReplyId === item._id} onClick={() => void deleteOwnReply(item._id)}>{deletingReplyId === item._id ? "deleting…" : "delete"}</button>}
          {thread.canModerate && <button className="tiny-action" onClick={() => void moderateTarget("reply", item._id, Boolean(item.hiddenAt))}>{item.hiddenAt ? "restore" : "hide"}</button>}
          {!item.hiddenAt && (item.moderationStatus === undefined || item.moderationStatus === "approved") && <button className="tiny-action" onClick={() => void reportTarget("reply", item._id)}>report</button>}
        </div>}
      </div>
    </article>)}</div>
    <Card className="reply-box"><CardHeader><CardTitle>Leave a reply</CardTitle></CardHeader><CardContent><form onSubmit={doReply}><MarkdownEditor value={replyDraftState.draft.body} onChange={(body) => replyDraftState.change((current) => ({ ...current, body }))} placeholder={viewer?.profile ? "Add to the thread…" : "Sign in to join the conversation."} disabled={!viewer?.profile || !replyDraftState.ready} rows={5} />{replyDraftState.recovered && <p className="draft-recovered">Recovered a draft saved on this device.</p>}<div className="form-footer">{replyError && <p className="form-error">{replyError}</p>}<Button type={viewer?.profile ? "submit" : "button"} onClick={!viewer?.profile ? onNeedAuth : undefined} disabled={busy || !replyDraftState.ready || (Boolean(viewer?.profile) && replyDraftState.draft.body.trim().length < 2)}>{viewer?.profile ? (busy ? "Checking safety…" : "POST REPLY") : "SIGN IN TO REPLY"}</Button></div></form></CardContent></Card>
    {showEditor && viewer?.user && <ThreadEditor userId={viewer.user._id} thread={thread} onClose={() => setShowEditor(false)} />}
  </section>;
}

function ReplyEditor({ userId, reply, onCancel, onSaved }: { userId: Id<"users">; reply: ReplyItem; onCancel: () => void; onSaved: () => void }) {
  const update = useAction(api.contentModeration.updateReply);
  const savedDraft = useSavedDraft(`reply-edit:${userId}:${reply._id}`, { submissionId: "", body: reply.body });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await savedDraft.persistNow();
    setBusy(true);
    setError("");
    try {
      await update({ submissionId: savedDraft.draft.submissionId, replyId: reply._id, body: savedDraft.draft.body });
      await savedDraft.clear();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return <form className="reply-editor" onSubmit={submit}>
    <MarkdownEditor value={savedDraft.draft.body} onChange={(body) => savedDraft.change((current) => ({ ...current, body }))} rows={5} disabled={!savedDraft.ready} autoFocus />
    {savedDraft.recovered && <p className="draft-recovered">Recovered an edit saved on this device.</p>}
    {error && <p className="form-error">{error}</p>}
    <div className="editor-actions"><Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button><Button type="submit" size="sm" disabled={busy || !savedDraft.ready || savedDraft.draft.body.trim().length < 2}>{busy ? "Checking safety…" : "SAVE REPLY"}</Button></div>
  </form>;
}

function ThreadEditor({ userId, thread, onClose }: { userId: Id<"users">; thread: ThreadDetail; onClose: () => void }) {
  const update = useAction(api.contentModeration.updateThread);
  const generateUploadUrl = useMutation(api.forum.generateProjectImageUploadUrl);
  const savedDraft = useSavedDraft(`thread-edit:${userId}:${thread._id}`, {
    submissionId: "",
    title: thread.title,
    body: thread.body,
    metadata: thread.metadata.map((item) => ({ key: item.key, value: item.value })),
    projectUrl: thread.projectUrl ?? "",
    imageAltText: thread.imageAltText ?? "",
    tags: thread.tags,
    image: null as File | null,
    removeExistingImage: false,
  });
  const draft = savedDraft.draft;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function selectImage(file: File | undefined) {
    setError("");
    if (file === undefined) return savedDraft.change((current) => ({ ...current, image: null }));
    if (!file.type.startsWith("image/")) return setError("Choose an image file.");
    if (file.size > 5 * 1024 * 1024) return setError("Project images must be 5 MB or smaller.");
    savedDraft.change((current) => ({ ...current, image: file, removeExistingImage: false }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await savedDraft.persistNow();
    setBusy(true);
    setError("");
    try {
      let imageStorageId: Id<"_storage"> | undefined;
      if (thread.board === "projects" && draft.image !== null) {
        const uploadUrl = await generateUploadUrl();
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": draft.image.type },
          body: draft.image,
        });
        if (!response.ok) throw new Error("The image upload did not finish. Try again.");
        const uploaded = await response.json() as { storageId: Id<"_storage"> };
        imageStorageId = uploaded.storageId;
      }
      await update({
        submissionId: draft.submissionId,
        board: thread.board,
        threadId: thread._id,
        title: draft.title,
        body: draft.body,
        metadata: thread.board === "projects" ? draft.metadata.filter((item) => item.key.trim() && item.value.trim()) : [],
        tags: thread.board === "projects" ? draft.tags : [],
        projectUrl: thread.board === "projects" && draft.projectUrl.trim() ? draft.projectUrl.trim() : undefined,
        imageAltText: thread.board === "projects" && draft.imageAltText.trim() ? draft.imageAltText.trim() : undefined,
        imageStorageId,
        removeImage: thread.board === "projects" ? draft.removeExistingImage : undefined,
      });
      await savedDraft.clear();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return <Modal title="Edit thread" onClose={onClose}>
    <form className="stack-form" onSubmit={submit}>
      {savedDraft.recovered && <p className="draft-recovered">Recovered an edit saved on this device.</p>}
      <div><Label htmlFor="edit-thread-title">Title</Label><Input id="edit-thread-title" value={draft.title} onChange={(event) => savedDraft.change((current) => ({ ...current, title: event.target.value }))} disabled={!savedDraft.ready} /></div>
      <div><Label htmlFor="edit-thread-body">Post</Label><MarkdownEditor id="edit-thread-body" value={draft.body} onChange={(body) => savedDraft.change((current) => ({ ...current, body }))} rows={9} disabled={!savedDraft.ready} /></div>
      {thread.board === "projects" && <>
        <div className="project-media-fields">
          <div><Label htmlFor="edit-project-link">Project link <span className="quiet">(optional)</span></Label><div className="input-with-icon"><LinkIcon /><Input id="edit-project-link" type="url" value={draft.projectUrl} onChange={(event) => savedDraft.change((current) => ({ ...current, projectUrl: event.target.value }))} placeholder="https://your-project.example" disabled={!savedDraft.ready} /></div></div>
          <div>
            <Label htmlFor="edit-project-image">Project image <span className="quiet">(optional, one image, max 5 MB)</span></Label>
            {thread.imageUrl && !draft.removeExistingImage && draft.image === null && <div className="existing-image-row"><Image unoptimized src={thread.imageUrl} alt="Current project image" width={72} height={72} /><span>Current image</span></div>}
            <label className="image-picker" htmlFor="edit-project-image"><ImagePlus /><span>{draft.image ? draft.image.name : thread.imageUrl && !draft.removeExistingImage ? "Choose a replacement" : "Choose PNG, JPEG, GIF, or WebP"}</span></label>
            <input id="edit-project-image" className="visually-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={!savedDraft.ready} onChange={(event) => selectImage(event.target.files?.[0])} />
            {draft.image && <button type="button" className="remove-image" onClick={() => savedDraft.change((current) => ({ ...current, image: null }))}>Clear replacement</button>}
            {thread.imageUrl && draft.image === null && <button type="button" className="remove-image" onClick={() => savedDraft.change((current) => ({ ...current, removeExistingImage: !current.removeExistingImage }))}>{draft.removeExistingImage ? "Keep current image" : "Remove current image"}</button>}
            <Label htmlFor="edit-project-alt">Image description <span className="quiet">(optional; leave empty if decorative)</span></Label><Input id="edit-project-alt" value={draft.imageAltText} onChange={(event) => savedDraft.change((current) => ({ ...current, imageAltText: event.target.value }))} maxLength={280} placeholder="What is visible in the image?" />
          </div>
        </div>
        <TagInput tags={draft.tags} setTags={(tags) => savedDraft.change((current) => ({ ...current, tags }))} inputId="edit-project-tags" />
        <div><Label>Project details <span className="quiet">(up to 6 free-text fields)</span></Label>{draft.metadata.map((item, index) => <div className="meta-input-row" key={index}><Input aria-label={`Metadata key ${index + 1}`} value={item.key} onChange={(event) => savedDraft.change((current) => ({ ...current, metadata: current.metadata.map((entry, itemIndex) => itemIndex === index ? { ...entry, key: event.target.value } : entry) }))} placeholder="field" /><Input aria-label={`Metadata value ${index + 1}`} value={item.value} onChange={(event) => savedDraft.change((current) => ({ ...current, metadata: current.metadata.map((entry, itemIndex) => itemIndex === index ? { ...entry, value: event.target.value } : entry) }))} placeholder="whatever belongs here" /></div>)}{draft.metadata.length < 6 && <button type="button" className="add-field" onClick={() => savedDraft.change((current) => ({ ...current, metadata: [...current.metadata, { key: "", value: "" }] }))}>+ add another field</button>}</div>
      </>}
      {error && <p className="form-error">{error}</p>}
      <div className="editor-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !savedDraft.ready || draft.title.trim().length < 3 || draft.body.trim().length < 3}>{busy ? (draft.image ? "Uploading and checking…" : "Checking safety…") : "SAVE CHANGES"}</Button></div>
    </form>
  </Modal>;
}

function Composer({ userId, board, onClose, onCreated }: { userId: Id<"users">; board: Board; onClose: () => void; onCreated: (id: Id<"threads">, slug?: string) => void }) {
  const create = useAction(api.contentModeration.createThread);
  const generateUploadUrl = useMutation(api.forum.generateProjectImageUploadUrl);
  const savedDraft = useSavedDraft(`thread-create:${userId}:${board}`, {
    submissionId: "",
    title: "",
    body: "",
    status: "published" as "draft" | "published",
    metadata: [{ key: "built with", value: "" }, { key: "status", value: "" }],
    projectUrl: "",
    imageAltText: "",
    tags: [] as string[],
    image: null as File | null,
  });
  const draft = savedDraft.draft;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function selectImage(file: File | undefined) {
    setError("");
    if (file === undefined) return savedDraft.change((current) => ({ ...current, image: null }));
    if (!file.type.startsWith("image/")) return setError("Choose an image file.");
    if (file.size > 5 * 1024 * 1024) return setError("Project images must be 5 MB or smaller.");
    savedDraft.change((current) => ({ ...current, image: file }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await savedDraft.persistNow();
    setBusy(true);
    setError("");
    try {
      let imageStorageId: Id<"_storage"> | undefined;
      if (board === "projects" && draft.image !== null) {
        const uploadUrl = await generateUploadUrl();
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": draft.image.type },
          body: draft.image,
        });
        if (!response.ok) throw new Error("The image upload did not finish. Try again.");
        const uploaded = await response.json() as { storageId: Id<"_storage"> };
        imageStorageId = uploaded.storageId;
      }
      const result = await create({
        submissionId: draft.submissionId,
        board,
        title: draft.title,
        body: draft.body,
        status: draft.status,
        metadata: board === "projects" ? draft.metadata.filter((item) => item.key.trim() && item.value.trim()) : [],
        tags: board === "projects" ? draft.tags : [],
        projectUrl: board === "projects" && draft.projectUrl.trim() ? draft.projectUrl.trim() : undefined,
        imageAltText: board === "projects" && draft.imageAltText.trim() ? draft.imageAltText.trim() : undefined,
        imageStorageId,
      });
      await savedDraft.clear();
      onCreated(result.threadId, result.slug);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return <Modal title={`New thread in ${boardInfo(board).title}`} onClose={onClose}>
    <form className="stack-form" onSubmit={submit}>
      {savedDraft.recovered && <p className="draft-recovered">Recovered a draft saved on this device.</p>}
      <div><Label htmlFor="thread-title">Title</Label><Input id="thread-title" value={draft.title} onChange={(event) => savedDraft.change((current) => ({ ...current, title: event.target.value }))} placeholder="A descriptive, non-optimized title" disabled={!savedDraft.ready} /></div>
      <div><Label htmlFor="thread-body">First post</Label><MarkdownEditor id="thread-body" value={draft.body} onChange={(body) => savedDraft.change((current) => ({ ...current, body }))} rows={9} placeholder="What did you make, notice, break, or wonder?" disabled={!savedDraft.ready} /></div>
      {board === "projects" && <>
        <div className="status-picker"><button type="button" className={draft.status === "draft" ? "selected" : ""} onClick={() => savedDraft.change((current) => ({ ...current, status: "draft" }))}><LockKeyhole /> Draft<span>Only you and moderators can see it.</span></button><button type="button" className={draft.status === "published" ? "selected" : ""} onClick={() => savedDraft.change((current) => ({ ...current, status: "published" }))}><Sparkles /> Published<span>Visible to everyone; eligible for featuring.</span></button></div>
        <div className="project-media-fields">
          <div><Label htmlFor="project-link">Project link <span className="quiet">(optional)</span></Label><div className="input-with-icon"><LinkIcon /><Input id="project-link" type="url" value={draft.projectUrl} onChange={(event) => savedDraft.change((current) => ({ ...current, projectUrl: event.target.value }))} placeholder="https://your-project.example" disabled={!savedDraft.ready} /></div></div>
          <div><Label htmlFor="project-image">Project image <span className="quiet">(optional, one image, max 5 MB)</span></Label><label className="image-picker" htmlFor="project-image"><ImagePlus /><span>{draft.image ? draft.image.name : "Choose PNG, JPEG, GIF, or WebP"}</span></label><input id="project-image" className="visually-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={!savedDraft.ready} onChange={(event) => selectImage(event.target.files?.[0])} />{draft.image && <button type="button" className="remove-image" onClick={() => savedDraft.change((current) => ({ ...current, image: null }))}>Remove image</button>}<Label htmlFor="project-alt">Image description <span className="quiet">(optional; leave empty if decorative)</span></Label><Input id="project-alt" value={draft.imageAltText} onChange={(event) => savedDraft.change((current) => ({ ...current, imageAltText: event.target.value }))} maxLength={280} placeholder="What is visible in the image?" /></div>
        </div>
        <TagInput tags={draft.tags} setTags={(tags) => savedDraft.change((current) => ({ ...current, tags }))} inputId="project-tags" />
        <div><Label>Project details <span className="quiet">(up to 6 free-text fields)</span></Label>{draft.metadata.map((item, index) => <div className="meta-input-row" key={index}><Input aria-label={`Metadata key ${index + 1}`} value={item.key} onChange={(event) => savedDraft.change((current) => ({ ...current, metadata: current.metadata.map((entry, itemIndex) => itemIndex === index ? { ...entry, key: event.target.value } : entry) }))} placeholder="field" /><Input aria-label={`Metadata value ${index + 1}`} value={item.value} onChange={(event) => savedDraft.change((current) => ({ ...current, metadata: current.metadata.map((entry, itemIndex) => itemIndex === index ? { ...entry, value: event.target.value } : entry) }))} placeholder="whatever belongs here" /></div>)}{draft.metadata.length < 6 && <button type="button" className="add-field" onClick={() => savedDraft.change((current) => ({ ...current, metadata: [...current.metadata, { key: "", value: "" }] }))}>+ add another field</button>}</div>
      </>}
      {error && <p className="form-error">{error}</p>}
      <Button type="submit" disabled={busy || !savedDraft.ready || draft.title.trim().length < 3 || draft.body.trim().length < 3}>{busy ? (draft.image ? "Uploading and checking…" : "Checking safety…") : draft.status === "draft" && board === "projects" ? "SAVE DRAFT" : "POST THREAD"}</Button>
    </form>
  </Modal>;
}

const TAG_PRESETS = ["agents", "audio", "computer-vision", "games", "hardware", "local-ai", "models", "research", "tools", "weird-web", "writing"];

function TagInput({ tags, setTags, inputId }: { tags: string[]; setTags: (tags: string[]) => void; inputId: string }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const suggestions = TAG_PRESETS.filter((tag) => !tags.includes(tag) && tag.includes(deferredQuery)).slice(0, 6);

  function addTag(raw: string) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 24);
    if (tag.length < 2 || tags.includes(tag) || tags.length >= 5) return;
    setTags([...tags, tag]);
    setQuery("");
  }

  return <div className="tag-field">
    <Label htmlFor={inputId}>Tags <span className="quiet">(choose suggestions or add your own, up to 5)</span></Label>
    {tags.length > 0 && <div className="selected-tags">{tags.map((tag) => <button type="button" key={tag} onClick={() => setTags(tags.filter((item) => item !== tag))}>{tag}<X /></button>)}</div>}
    <div className="tag-search"><Input id={inputId} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addTag(query); } }} placeholder="Search tags or type something new" disabled={tags.length >= 5} /><Button type="button" variant="outline" onClick={() => addTag(query)} disabled={tags.length >= 5 || query.trim().length < 2}>Add</Button></div>
    {tags.length < 5 && <div className="tag-suggestions">{suggestions.map((tag) => <button type="button" key={tag} onClick={() => addTag(tag)}>{tag}</button>)}</div>}
  </div>;
}

function ProfileSetup() {
  const ensure = useAction(api.contentModeration.ensureProfile); const { signOut } = useClerk(); const [handle, setHandle] = useState(""); const [bio, setBio] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await ensure({ handle, bio }); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } }
  return <Modal title="Choose your board name"><p className="modal-intro">One last thing. This is the name that appears beside your threads and replies.</p><form className="stack-form" onSubmit={submit}><div><Label htmlFor="handle">Handle</Label><Input id="handle" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="nightcompiler" /></div><div><Label htmlFor="bio">Tiny bio</Label><Textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} placeholder="What do you make when nobody asked?" /></div>{error && <p className="form-error">{error}</p>}<Button type="submit" disabled={busy || handle.trim().length < 2}>{busy ? "Saving…" : "ENTER 3AMJ.SPACE"}</Button></form><button className="switch-auth" onClick={() => void signOut()}>Not now — sign out</button></Modal>;
}

function ProfileDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const update = useAction(api.contentModeration.updateProfile);
  const generateUploadUrl = useMutation(api.forum.generateProfileImageUploadUrl);
  const { openUserProfile } = useClerk();
  const [handle, setHandle] = useState(profile.handle);
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [bio, setBio] = useState(profile.bio);
  const [githubUrl, setGithubUrl] = useState(profile.githubUrl ?? "");
  const [links, setLinks] = useState(profile.links.map(({ label, url }) => ({ label, url })));
  const [avatar, setAvatar] = useState<File | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      let avatarStorageId: Id<"_storage"> | undefined;
      if (avatar !== null) {
        const response = await fetch(await generateUploadUrl(), { method: "POST", headers: { "Content-Type": avatar.type }, body: avatar });
        if (!response.ok) throw new Error("The profile image upload did not finish.");
        avatarStorageId = (await response.json() as { storageId: Id<"_storage"> }).storageId;
      }
      await update({ handle, displayName, bio, githubUrl, socialLinks: links, avatarStorageId, removeAvatar });
      onClose();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return <Modal title="Your 3AMJ.SPACE profile" onClose={onClose}><form className="stack-form" onSubmit={submit}>
    <div className="profile-image-editor">{profile.avatarUrl && !removeAvatar && !avatar ? <Image unoptimized src={profile.avatarUrl} alt="" width={72} height={72} /> : <div className="avatar-shape"><UserRound /></div>}<div><Label htmlFor="profile-image">Profile image <span className="quiet">(optional, max 5 MB)</span></Label><Input id="profile-image" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && file.size > 5 * 1024 * 1024) setError("Profile images must be 5 MB or smaller."); else { setAvatar(file); setRemoveAvatar(false); } }} />{profile.avatarUrl && <button type="button" className="tiny-action" onClick={() => { setAvatar(null); setRemoveAvatar(!removeAvatar); }}>{removeAvatar ? "keep current image" : "remove current image"}</button>}</div></div>
    <div><Label htmlFor="profile-display-name">Display name <span className="quiet">(optional)</span></Label><Input id="profile-display-name" value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} /></div>
    <div><Label htmlFor="profile-handle">Handle</Label><Input id="profile-handle" value={handle} onChange={(e) => setHandle(e.target.value)} /></div>
    <div><Label htmlFor="profile-bio">Tiny bio</Label><Textarea id="profile-bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={4} maxLength={280} /></div>
    <div><Label htmlFor="profile-github">GitHub <span className="quiet">(optional)</span></Label><Input id="profile-github" type="url" value={githubUrl} onChange={(e) => setGithubUrl(e.target.value)} placeholder="https://github.com/you" /></div>
    <div><Label>Other links <span className="quiet">(up to 3)</span></Label>{links.map((link, index) => <div className="meta-input-row" key={index}><Input aria-label={`Link label ${index + 1}`} value={link.label} onChange={(event) => setLinks(links.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} placeholder="Mastodon" /><Input aria-label={`Link URL ${index + 1}`} type="url" value={link.url} onChange={(event) => setLinks(links.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item))} placeholder="https://…" /><button type="button" className="tiny-action" onClick={() => setLinks(links.filter((_, itemIndex) => itemIndex !== index))}>remove</button></div>)}{links.length < 3 && <button type="button" className="add-field" onClick={() => setLinks([...links, { label: "", url: "" }])}>+ add a link</button>}</div>
    <p className="role-line"><Shield /> {profile.role === "moderator" ? "Moderator account" : "Member account"}</p>{error && <p className="form-error">{error}</p>}<Button type="submit" disabled={busy}>{busy ? "SAVING…" : "SAVE PROFILE"}</Button><Button type="button" variant="outline" onClick={() => { onClose(); openUserProfile(); }}>MANAGE SIGN-IN &amp; SECURITY</Button>
  </form></Modal>;
}

function PublicProfilePage({ handle, openThread }: { handle: string; openThread: (id: Id<"threads">, board?: Board, slug?: string) => void }) {
  const profile = useQuery(api.forum.getPublicProfile, { handle }) as PublicProfile | null | undefined;
  if (profile === undefined) return <LoadingCards count={3} />;
  if (profile === null) return <EmptyNote text="That member profile could not be found." />;
  return <section className="profile-page">
    <div className="profile-hero">{profile.avatarUrl ? <Image unoptimized src={profile.avatarUrl} alt="" width={112} height={112} /> : <div className="avatar-shape"><UserRound /></div>}<div><span className="kicker">MEMBER PROFILE</span><h1>{profile.displayName || `@${profile.handle}`}</h1>{profile.displayName && <p className="profile-handle">@{profile.handle}</p>}<p>{profile.bio || "No bio. The projects can do the talking."}</p><div className="profile-links">{profile.githubUrl && <a href={profile.githubUrl} target="_blank" rel="noreferrer"><Github /> GitHub</a>}{profile.links.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer"><Globe /> {link.label}</a>)}</div></div></div>
    <div className="section-heading"><h2>Published signals</h2><span className="chronology-label">Newest first</span></div>
    <div className="thread-list">{profile.threads.length === 0 ? <EmptyNote text="No published threads yet." /> : profile.threads.map((thread) => <button key={thread._id} className="profile-thread" onClick={() => openThread(thread._id, thread.board, thread.slug)}><span><b>{thread.title}</b><i className={`board-tag board-${thread.board}`}>{boardInfo(thread.board).title}</i></span><span>{thread.replyCount} replies · {displayDate(thread.lastActivityAt)}</span></button>)}</div>
  </section>;
}

function PolicyPage({ active }: { active: "rules" | "privacy" }) {
  return <article className="static-page policy-page">
    <span className="kicker">THE SMALL PRINT, KEPT SMALL</span>
    <h1>Rules &amp; privacy</h1>
    <nav className="policy-tabs" aria-label="Rules and privacy">
      <Link className={active === "rules" ? "active" : ""} aria-current={active === "rules" ? "page" : undefined} href="/rules">Community rules</Link>
      <Link className={active === "privacy" ? "active" : ""} aria-current={active === "privacy" ? "page" : undefined} href="/privacy">Privacy &amp; cookies</Link>
    </nav>
    {active === "rules" ? <RulesContent /> : <PrivacyContent />}
  </article>;
}

function RulesContent() {
  return <div className="policy-content">
    <p>3AMJ.SPACE is for strange, playful AI projects, unfinished experiments, useful failures, and generous conversation.</p>
    <h2>Bring curiosity</h2><p>Share work because it might interest another person, not because it is optimised to win attention. Honest context is more useful than hype.</p>
    <h2>Be kind to the person</h2><p>Disagree with ideas and techniques without humiliating, threatening, harassing, or targeting people. Do not publish private information.</p>
    <h2>Keep it yours to share</h2><p>Credit collaborators and sources. Do not post material you do not have permission to publish, impersonate somebody else, or misrepresent generated work.</p>
    <h2>Keep the space safe</h2><p>Do not post illegal content, scams, malware, sexual content involving minors, or instructions intended to cause real-world harm. Automated checks hide submissions while they are reviewed; moderators can also hide material.</p>
    <h2>Report quietly</h2><p>Use the report control when something needs a human look. Reports are private to moderators. They are not votes and do not affect ranking—there is no engagement ranking here.</p>
  </div>;
}

function PrivacyContent() {
  return <div className="policy-content">
    <p className="policy-date">PLAIN-LANGUAGE NOTICE · 4 SEPTEMBER 2026</p>
    <p>3AMJ.SPACE collects only what it needs to run a small public forum. It does not use advertising cookies, behavioural analytics, engagement scoring, or link-visit tracking.</p>
    <h2>Who is responsible</h2><p>The 3AMJ.SPACE operator is the data controller. Email <a href="mailto:privacy@3amj.space">privacy@3amj.space</a> about personal data.</p>
    <h2>What is processed</h2><p>Clerk handles sign-in and supplies an account identifier, email address, and optional name. Convex stores your public profile, posts, replies, project media, moderation state, and private reports. Vercel serves the site and may process ordinary request and diagnostic logs, including IP addresses. Public profile content, posts, replies, and uploaded images are sent to OpenAI for a safety classification before publication.</p>
    <h2>Why and lawful basis</h2><p>Account and publication data is processed to provide the service that members request. Safety, moderation, and basic service logs support the operator&apos;s legitimate interests in running a secure community. Data can also be processed to meet a legal obligation.</p>
    <h2>Cookies and browser storage</h2><p>Clerk sets cookies that are required for authentication. The site stores theme preference in the browser and keeps unfinished drafts in IndexedDB on that device. Drafts do not leave the device until you submit them. Because there are no optional tracking cookies, the site does not show a consent banner.</p>
    <h2>Retention and control</h2><p>You can edit or delete your own posts and replies. Local drafts are removed after successful submission and can also be cleared with browser controls. Some moderation records and infrastructure logs may be retained for safety, security, and legal reasons. OpenAI states that API abuse-monitoring logs may be retained for up to 30 days by default and are not used for model training unless the account opts in.</p>
    <h2>Automated safety checks</h2><p>OpenAI classifies submitted public text and images for safety. Flagged content is not published and its submitted content is removed from the forum database. Email the operator if you want a human review.</p>
    <h2>Service providers</h2><p><a href="https://clerk.com/legal/privacy" target="_blank" rel="noreferrer">Clerk</a>, <a href="https://www.convex.dev/legal/privacy" target="_blank" rel="noreferrer">Convex</a>, <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noreferrer">Vercel</a>, and <a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer">OpenAI</a> process data to provide their parts of the service.</p>
    <h2>International processing</h2><p>These providers can process data outside the United Kingdom. Their privacy notices describe their locations and transfer safeguards.</p>
    <h2>Your choices and rights</h2><p>You can ask for access, correction, deletion, restriction, portability, or an objection review when the relevant right applies. Email <a href="mailto:privacy@3amj.space">privacy@3amj.space</a>. People in the United Kingdom can also complain to the <a href="https://ico.org.uk/make-a-complaint/data-protection-complaints/" target="_blank" rel="noreferrer">Information Commissioner&apos;s Office</a>.</p>
  </div>;
}

function ModerationPage({ onBack }: { onBack: () => void }) {
  const log = useQuery(api.forum.listModerationLog, { limit: 30 }) as ModerationItem[] | undefined;
  const reports = useQuery(api.forum.listOpenReports, { limit: 50 }) as ReportItem[] | undefined;
  const resolveReport = useMutation(api.forum.resolveReport);
  const router = useRouter();
  return <section className="moderation-page"><button className="back-link" onClick={onBack}><ArrowLeft /> FRONT DESK</button><div className="mod-header"><Shield /><div><span className="kicker">STAFF ROOM</span><h1>Moderation</h1><p>Member reports stay private. Resolving a report removes it from this queue; hide and restore controls remain on the content.</p></div></div><div className="section-heading"><h2>Open reports</h2><span className="chronology-label">Oldest first</span></div><div className="report-list">{reports === undefined ? <LoadingCards count={2} /> : reports.length === 0 ? <EmptyNote text="No open reports. Quiet night." /> : reports.map((item) => <article key={item._id}><div><span>{displayDate(item._creationTime)} · @{item.reporterHandle}</span><strong>{item.targetType.toUpperCase()}</strong><p>{item.reason}</p><blockquote>{item.context}</blockquote></div><div>{item.threadId && <Button size="sm" variant="outline" onClick={() => router.push(`/threads/${item.threadId}`)}>Review</Button>}<Button size="sm" variant="ghost" onClick={() => void resolveReport({ reportId: item._id })}><Check /> Resolve</Button></div></article>)}</div><div className="section-heading"><h2>Action log</h2></div><div className="mod-log">{log === undefined ? <LoadingCards count={3} /> : log.length === 0 ? <EmptyNote text="No moderation actions yet." /> : log.map((item) => <div key={item._id}><span>{displayDate(item._creationTime)}</span><strong>{item.action.toUpperCase()} {item.targetType.toUpperCase()}</strong><code>{item.targetId.slice(-8)}</code><p>{item.reason}</p></div>)}</div></section>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose?: () => void }) { return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}><Card className="modal-card"><CardHeader className="modal-header"><CardTitle>{title}</CardTitle>{onClose && <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X /></Button>}</CardHeader><CardContent>{children}</CardContent></Card></div>; }
function LoadingCards({ count }: { count: number }) { return <>{Array.from({ length: count }).map((_, index) => <div className="loading-card" key={index}><span /><div><i /><i /></div></div>)}</>; }
function EmptyNote({ text }: { text: string }) { return <div className="empty-note"><Wrench /><p>{text}</p></div>; }
