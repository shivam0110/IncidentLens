import Dashboard from "@/components/dashboard";
import { dashboardIncidents, readEvaluation } from "./dashboard-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <Dashboard incidents={dashboardIncidents} evaluation={await readEvaluation()} />;
}
