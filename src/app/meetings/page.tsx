import { redirect } from "next/navigation";

/**
 * Meetings is no longer a product surface. A meeting is an information
 * source: it enriches a deal, updates a person, or gets ignored — all of
 * which happens in the Inbox. Old links land on the Granola-filtered queue.
 */
export default function Meetings() {
  redirect("/inbox?source=granola");
}
