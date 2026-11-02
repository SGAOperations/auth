"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createProductApiKey, revokeProductApiKey } from "./actions";

const FAILURE_COPY: Record<string, string> = {
  TOO_MANY_KEYS: "Revoke a key first: a product can hold three live keys.",
  NOT_FOUND: "This product or key no longer exists.",
  RATE_LIMITED: "Too many changes. Try again in a minute.",
  FORBIDDEN: "You don't have permission to do that.",
};

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * A product's server-to-server keys (#312). A new key is shown once, here, and
 * is never readable again; the list shows each key's public prefix only.
 */
export function ApiKeysCard({
  productId,
  keys,
}: {
  productId: string;
  keys: ApiKeyRow[];
}) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setCreated(null);
    try {
      const result = await createProductApiKey(productId, name);
      if (result.ok) {
        setCreated(result.key ?? null);
        setName("");
      } else {
        setError(
          ("message" in result && result.message) ||
            FAILURE_COPY[result.code] ||
            "Something went wrong. Try again.",
        );
      }
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function revoke(keyId: string) {
    try {
      const result = await revokeProductApiKey(productId, keyId);
      if (!result.ok) {
        toast.error(FAILURE_COPY[result.code] ?? "Something went wrong.");
      }
    } catch {
      toast.error("Something went wrong. Try again.");
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      toast.success("Copied.");
    } catch {
      toast.error("Copy failed. Select the key and copy it.");
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>
          For the product&apos;s server, when it calls SGAuth without a
          user&apos;s session, such as to look up who a Slack user is. Store a
          key as a secret environment variable; it is shown only once.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {created ? (
          <div
            role="status"
            className="flex flex-col gap-2 rounded-md border p-3 text-sm"
          >
            <p>Copy this key now. It won&apos;t be shown again.</p>
            <code className="break-all font-mono text-xs">{created}</code>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              onClick={copy}
            >
              Copy key
            </Button>
          </div>
        ) : null}

        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No keys yet.</p>
        ) : (
          <ul className="flex flex-col divide-y text-sm">
            {keys.map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="flex flex-col">
                  <span className="break-words">{key.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    sgak_{key.prefix}_…
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Created {key.createdAt}
                    {key.lastUsedAt ? `, last used ${key.lastUsedAt}` : ""}
                    {key.revokedAt ? `, revoked ${key.revokedAt}` : ""}
                  </span>
                </div>
                {key.revokedAt ? null : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => revoke(key.id)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={create} className="flex flex-col gap-2">
          <Label htmlFor="api-key-name">New key name</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="api-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="production"
              maxLength={60}
              autoComplete="off"
              className="max-w-xs"
            />
            <Button type="submit" disabled={pending || name.trim() === ""}>
              {pending ? "Creating…" : "Create key"}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
