import { Suspense } from "react";
import { MagicSignIn } from "@/components/MagicSignIn";

/** Landing page for magic sign-in links: exchanges the token for a session. */
export default function MagicPage() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-bg px-6">
      <Suspense fallback={null}>
        <MagicSignIn />
      </Suspense>
    </main>
  );
}
