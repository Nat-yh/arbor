import StateBoundary from "@/components/StateBoundary";
import ItemDetail from "./ItemDetail";

export default function Page() {
  return (
    <StateBoundary>
      <ItemDetail />
    </StateBoundary>
  );
}
