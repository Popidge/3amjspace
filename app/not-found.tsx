import Link from "next/link";

export default function NotFound() {
  return <main className="page-wrap"><article className="static-page"><span className="kicker">SIGNAL LOST</span><h1>That page could not be found.</h1><p>The link can be old, private, or from another dimension.</p><p><Link href="/">Return to the front desk</Link></p></article></main>;
}
