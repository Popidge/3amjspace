import { ForumApp } from "../../page";
import { notFound } from "next/navigation";

export default async function ProjectRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id.length > 100 || !/^(?:[a-z0-9]{20,}|post-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{4,32})$/i.test(id)) notFound();
  return <ForumApp route={{ kind: "thread", id, board: "projects" }} />;
}
