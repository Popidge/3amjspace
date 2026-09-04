import { notFound } from "next/navigation";
import { ForumApp } from "../../page";

const boards = ["projects", "ideas", "tech", "general"] as const;

export default async function BoardRoute({ params }: { params: Promise<{ board: string }> }) {
  const { board } = await params;
  if (!boards.includes(board as (typeof boards)[number])) notFound();
  return <ForumApp route={{ kind: "board", board: board as (typeof boards)[number] }} />;
}
