import { useRef, type ChangeEvent } from "react";
import { Button } from "../../components/ui/Button";
import { parseGoogleDesktopCredentials, type GoogleDesktopCredentials } from "./connection";

export function GoogleCredentialsImport({ disabled, managedClientId, onImport, onError }: {
  disabled: boolean;
  managedClientId?: string;
  onImport: (credentials: GoogleDesktopCredentials) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      await onImport(parseGoogleDesktopCredentials(await file.text(), managedClientId));
    } catch (error) {
      onError(error);
    }
  }

  return <>
    <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={event => void importFile(event)} />
    <Button type="button" variant="secondary" size="sm" disabled={disabled}
      onClick={() => fileRef.current?.click()}>Importar credenciais JSON</Button>
  </>;
}
