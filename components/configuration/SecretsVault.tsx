"use client";
import { useState, useEffect, useMemo } from "react";
import { useAccount } from "../auth/AccountProvider";
import { Button } from "../ui/button";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "../ui/select";
import { Input } from "../ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { parseSources } from "@/lib/domain/importer";
import { at, list, object, text } from "@/lib/domain/types";
import type { Snapshot } from "@/lib/domain/snapshot";
export function SecretsVault({
  project,
  revision,
}: {
  project: Snapshot;
  revision?: string;
}) {
  const account = useAccount();
  const [secretType, setSecretType] = useState("Opaque");
  const [vaultRole, setVaultRole] = useState(""),
    [vaultMount, setVaultMount] = useState("secret"),
    [vaultPath, setVaultPath] = useState(""),
    [vaultConfigured, setVaultConfigured] = useState<
      { mount: string; path: string; role: string; keys: string[] }[]
    >([]);
  const [configured, setConfigured] = useState<
      { name: string; namespace: string; keys: string[] }[]
    >([]),
    [name, setName] = useState(""),
    [namespace, setNamespace] = useState("default"),
    [values, setValues] = useState<Record<string, string>>({}),
    [key, setKey] = useState(""),
    [value, setValue] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const dependencies = useMemo(() => {
    const resources = parseSources(project.files).resources;
    const names = new Map<
      string,
      { name: string; namespace: string; keys: Set<string> }
    >();
    const add = (name: string, namespace: string, key?: string) => {
      if (!name) return;
      const id = namespace + "/" + name;
      const ref = names.get(id) ?? { name, namespace, keys: new Set<string>() };
      if (key) ref.keys.add(key);
      names.set(id, ref);
    };
    const vault: { resource: string; annotations: string[] }[] = [];
    for (const r of resources) {
      const ns = r.namespace ?? "default";
      if (r.kind === "Secret") {
        let keys: string[] = [];
        try {
          keys = JSON.parse(
            text(
              at(r.raw, "metadata", "annotations", "waypoint.dev/secret-keys"),
            ) || "[]",
          );
        } catch {}
        for (const k of [
          ...Object.keys(object(r.raw.data)),
          ...Object.keys(object(r.raw.stringData)),
          ...keys,
        ])
          add(r.name, ns, k);
        add(r.name, ns);
      }
      const pod = object(
        r.kind === "Pod" ? r.raw.spec : at(r.raw, "spec", "template", "spec"),
      );
      for (const c of [...list(pod.containers), ...list(pod.initContainers)]) {
        for (const e of list(c.env)) {
          const ref = object(at(e, "valueFrom", "secretKeyRef"));
          add(text(ref.name), ns, text(ref.key));
        }
        for (const e of list(c.envFrom))
          add(text(at(e, "secretRef", "name")), ns);
      }
      for (const v of list(pod.volumes)) {
        add(text(at(v, "secret", "secretName")), ns);
        if (at(v, "csi", "driver") === "secrets-store.csi.k8s.io")
          add(
            text(at(v, "csi", "volumeAttributes", "secretProviderClass")),
            ns,
          );
      }
      if (r.kind === "SecretProviderClass") add(r.name, ns);
      const annotations = Object.keys({
        ...object(at(r.raw, "metadata", "annotations")),
        ...object(at(r.raw, "spec", "template", "metadata", "annotations")),
      }).filter((k) => k.startsWith("vault.hashicorp.com/"));
      if (
        annotations.length ||
        /vault/i.test(r.kind) ||
        r.kind === "SecretProviderClass"
      )
        vault.push({ resource: r.kind + "/" + r.name, annotations });
    }
    return { secrets: [...names.values()], vault };
  }, [project]);
  useEffect(() => {
    let alive = true;
    account
      .request("/api/configuration")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw Error(d.error);
        if (alive) {
          setConfigured(d.secrets);
          setVaultConfigured(d.vault?.entries ?? []);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [project.id, account.request]);
  async function save() {
    if (!revision) return;
    setBusy(true);
    setError("");
    try {
      const r = await account.request("/api/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectRevision: revision,
          secret: { name, namespace, values, type: "Opaque" },
        }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      setConfigured(d.secrets);
      setValues({});
      setValue("");
      setMessage(
        "Local test values saved. Review the deployment plan again before starting a lab.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveVault() {
    if (!revision) return;
    setBusy(true);
    setError("");
    try {
      const r = await account.request("/api/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectRevision: revision,
          vault: {
            role: vaultRole,
            mount: vaultMount,
            path: vaultPath,
            values,
          },
        }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      setVaultConfigured(d.vault?.entries ?? []);
      setValues({});
      setValue("");
      setMessage(
        "Local Vault test values saved. Review the deployment plan before creating the lab.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-6 p-6 max-w-4xl">
      <p className="text-muted-foreground">
        Configure test values for this application. Values stay in protected
        files on this computer and are applied only to the owned lab.
      </p>
      {error && <p role="alert">{error}</p>}
      <Card>
        <CardHeader>
          <CardTitle>Required Secrets</CardTitle>
        </CardHeader>
        <CardContent>
          {dependencies.secrets.length ? (
            dependencies.secrets.map((s) => (
              <div
                className="flex justify-between items-center border-b py-3"
                key={s.namespace + "/" + s.name}
              >
                <div>
                  <strong>
                    {s.namespace}/{s.name}
                  </strong>
                  <p className="text-sm text-muted-foreground">
                    {[...s.keys].join(", ") ||
                      "Keys defined by the application"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    setName(s.name);
                    setNamespace(s.namespace);
                    setValues({});
                    setMessage("");
                  }}
                >
                  Configure
                </Button>
              </div>
            ))
          ) : (
            <p>No Kubernetes Secret references detected.</p>
          )}
          {configured.map((s) => (
            <p className="mt-3 text-sm" key={s.namespace + "/" + s.name}>
              {s.namespace}/{s.name}: {s.keys.length} local keys configured
            </p>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Local test Secret</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="block space-y-2">
              Secret type
              <Select value={secretType} onValueChange={setSecretType}>
                <SelectTrigger aria-label="Secret type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Opaque">
                    Application test values
                  </SelectItem>
                  <SelectItem value="kubernetes.io/dockerconfigjson">
                    Registry pull credentials
                  </SelectItem>
                  <SelectItem value="kubernetes.io/tls">
                    Local TLS certificate
                  </SelectItem>
                </SelectContent>
              </Select>
            </label>
            {secretType === "kubernetes.io/dockerconfigjson" && (
              <p className="text-sm text-muted-foreground">
                Use key .dockerconfigjson with your test registry configuration
                JSON. The reviewed plan attaches this Secret to workloads in its
                source namespace. Do not paste credentials into chat.
              </p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <label className="space-y-2">
                Namespace
                <Input
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                />
              </label>
              <label className="space-y-2">
                Secret name
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <label className="space-y-2">
                Key
                <Input value={key} onChange={(e) => setKey(e.target.value)} />
              </label>
              <label className="space-y-2">
                Test value
                <Input
                  type="password"
                  autoComplete="off"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!key || !value}
              onClick={() => {
                setValues((v) => ({ ...v, [key]: value }));
                setKey("");
                setValue("");
              }}
            >
              Add key
            </Button>
            <div>
              {Object.keys(values).map((k) => (
                <Button
                  type="button"
                  variant="ghost"
                  key={k}
                  onClick={() =>
                    setValues((v) =>
                      Object.fromEntries(
                        Object.entries(v).filter(([name]) => name !== k),
                      ),
                    )
                  }
                >
                  {k} · remove
                </Button>
              ))}
            </div>
            <Button
              disabled={
                busy || !revision || !name || !Object.keys(values).length
              }
            >
              Save local test values
            </Button>
            {message && (
              <p role="status" className="text-sm">
                {message}
              </p>
            )}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Vault dependencies</CardTitle>
        </CardHeader>
        <CardContent>
          {dependencies.vault.length ? (
            dependencies.vault.map((v) => (
              <div key={v.resource} className="mb-4">
                <strong>{v.resource}</strong>
                <p className="text-sm text-muted-foreground">
                  {v.annotations.join(", ")}
                </p>
              </div>
            ))
          ) : (
            <p>
              No Vault integration declared in these manifests. Connections
              configured inside application code cannot be discovered
              automatically.
            </p>
          )}
          <p className="mt-3 text-sm text-muted-foreground">
            Configure a disposable local Vault for Agent-injected KV v2 secrets.
            Source Vault servers are never contacted. CSI providers use the
            explicit local test-Secret mapping above.
          </p>
          <div className="grid grid-cols-3 gap-4 mt-4">
            <label>
              Vault role
              <Input
                value={vaultRole}
                onChange={(e) => setVaultRole(e.target.value)}
              />
            </label>
            <label>
              KV mount
              <Input
                value={vaultMount}
                onChange={(e) => setVaultMount(e.target.value)}
              />
            </label>
            <label>
              Secret path
              <Input
                value={vaultPath}
                onChange={(e) => setVaultPath(e.target.value)}
              />
            </label>
          </div>
          <p className="text-sm mt-3 text-muted-foreground">
            Add keys and test values using the fields above, then save them to
            Vault. An annotation for secret/data/example uses mount “secret” and
            path “example”.
          </p>
          <Button
            className="mt-3"
            disabled={
              busy ||
              !revision ||
              !vaultRole ||
              !vaultPath ||
              !Object.keys(values).length
            }
            onClick={saveVault}
          >
            Configure local Vault test values
          </Button>
          <p className="text-xs mt-3 text-muted-foreground">
            This creates a protected local test credential. Starting the
            reviewed lab installs the official HashiCorp chart and injector in
            its owned cluster. Vault data is disposable and reseeded from these
            test values.
          </p>
          {vaultConfigured.map((v) => (
            <p className="text-sm mt-3" key={v.role + v.mount + v.path}>
              {v.role} · {v.mount}/data/{v.path} · {v.keys.length} configured
              keys
            </p>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
