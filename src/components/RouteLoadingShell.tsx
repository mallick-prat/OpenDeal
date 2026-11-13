import { OrgLogo } from "./Sidebar";

export function RouteLoadingShell() {
  return (
    <div className="flex min-h-[100dvh] bg-bg">
      <aside className="sticky top-0 hidden h-[100dvh] w-56 shrink-0 flex-col border-r border-line bg-bg md:flex">
        <div className="flex items-center px-5 py-5">
          <OrgLogo size={36} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="mx-5 h-12 skeleton" />
          ))}
        </div>
        <div className="border-t border-line px-5 pb-5 pt-4">
          <div className="mb-4 flex items-center gap-3">
            <div className="h-9 w-9 skeleton" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3 w-24 skeleton" />
              <div className="h-2.5 w-32 skeleton" />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="h-3 w-16 skeleton" />
            <div className="h-3 w-14 skeleton" />
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <main className="mx-auto w-full max-w-[1500px] px-4 pb-24 pt-8 sm:px-8">
          <div aria-hidden>
            <div className="h-3 w-24 skeleton" />
            <div className="mt-3 h-11 w-64 skeleton" />
            <div className="mt-6 border border-line p-4">
              <div className="h-9 w-full skeleton" />
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {Array.from({ length: 7 }, (_, i) => (
                  <div key={i} className="h-16 border border-line skeleton" />
                ))}
              </div>
            </div>
          </div>
          <p className="sr-only" role="status">
            Loading…
          </p>
        </main>
      </div>
    </div>
  );
}
