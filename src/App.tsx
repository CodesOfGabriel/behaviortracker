import { AppShell } from "./components/AppShell";
import { ColabGate } from "./features/colab/ColabGate";
import { Dashboard } from "./features/dashboard/Dashboard";
import { NewExperiment } from "./features/experiments/NewExperiment";
import { Results } from "./features/results/Results";
import { ForcedSwimResults } from "./features/results/ForcedSwimResults";
import { useAppStore } from "./store/AppStore";

export default function App() {
  const { route, getExperiment } = useAppStore();
  let content;
  switch (route.name) {
    case "new-experiment":
      content = <NewExperiment />;
      break;
    case "results":
      content = getExperiment(route.experimentId)?.testType === "forced_swim"
        ? <ForcedSwimResults key={route.experimentId} experimentId={route.experimentId} />
        : <Results key={route.experimentId} experimentId={route.experimentId} />;
      break;
    case "colab":
      content = <ColabGate />;
      break;
    default:
      content = <Dashboard />;
  }
  return <AppShell>{content}</AppShell>;
}

