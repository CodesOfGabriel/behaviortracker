import { AppShell } from "./components/AppShell";
import { ColabGate } from "./features/colab/ColabGate";
import { Dashboard } from "./features/dashboard/Dashboard";
import { NewExperiment } from "./features/experiments/NewExperiment";
import { Results } from "./features/results/Results";
import { TrackingEditor } from "./features/tracking/TrackingEditor";
import { useAppStore } from "./store/AppStore";

export default function App() {
  const { route } = useAppStore();
  let content;
  switch (route.name) {
    case "new-experiment":
      content = <NewExperiment />;
      break;
    case "editor":
      content = <TrackingEditor key={route.experimentId} experimentId={route.experimentId} />;
      break;
    case "results":
      content = <Results key={route.experimentId} experimentId={route.experimentId} />;
      break;
    case "colab":
      content = <ColabGate />;
      break;
    default:
      content = <Dashboard />;
  }
  return <AppShell>{content}</AppShell>;
}

