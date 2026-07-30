import { Dashboard } from "@/components/Dashboard";
import { loadErpData } from "@/lib/data-source.server";

export default async function Home() {
  const ingestion = await loadErpData();
  return <Dashboard ingestion={ingestion} />;
}
