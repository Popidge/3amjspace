import { ForumApp } from "../../page";

export default async function ProfileRoute({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return <ForumApp route={{ kind: "profile", handle }} />;
}
