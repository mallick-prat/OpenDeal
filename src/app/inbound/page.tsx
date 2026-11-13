import { redirect } from "next/navigation";

/** The queue moved to /inbox when candidates became addressable. */
export default function InboundRedirect() {
  redirect("/inbox");
}
