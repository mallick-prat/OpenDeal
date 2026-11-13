import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LoginForm } from "@/components/LoginForm";
import { OrgLogo } from "@/components/Sidebar";
import { crm } from "@/config/crm.config";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <div className="grid min-h-[100dvh] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* Left: brand panel, a dark wash of your brand color (set in crm.config.ts) */}
      <div
        className="relative hidden flex-col justify-between p-12 lg:flex"
        style={{
          backgroundImage:
            "linear-gradient(155deg, var(--brand-red-950), var(--brand-red-700) 60%, var(--brand-red-500))",
        }}
      >
        <div className="flex items-center gap-3 text-white">
          <OrgLogo size={40} />
          <span className="text-[20px] font-normal">{crm.org.name}</span>
        </div>
        <div className="max-w-md">
          <h2 className="text-[34px] font-light leading-tight text-white">
            {crm.pipelineName}
          </h2>
        </div>
      </div>

      {/* Right: sign-in */}
      <div className="flex items-center justify-center bg-bg px-6 py-16">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <div className="flex items-center gap-2.5">
              <OrgLogo size={32} />
              <span className="text-[20px] font-normal text-ink">{crm.org.name}</span>
            </div>
            <p className="mt-3 text-[14px] leading-relaxed text-sub">
              Sign in to continue.
            </p>
          </div>
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
