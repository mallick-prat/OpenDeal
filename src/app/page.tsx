import { DashboardPage } from "./DashboardPage";

// Give slow-database renders room to finish (or fail gracefully) instead of
// hitting the platform default and returning a bare 504.
export const maxDuration = 60;

export const revalidate = 900;

export default function Home() {
  return <DashboardPage initialView="home" />;
}
