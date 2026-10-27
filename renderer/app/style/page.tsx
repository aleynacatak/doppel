"use client";

import { useState } from "react";
import { StyleRules } from "@/components/style/StyleRules";
import { StyleSources } from "@/components/style/StyleSources";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading } from "@/components/ui/Progress";
import { Section } from "@/components/ui/Section";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useAsync } from "@/lib/hooks";

export default function StylePage() {
  const { data: profile, loading, setData } = useAsync(() => doppel().getStyleProfile(), []);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<"indesign" | "figma" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addInDesign = async () => {
    setBusy("indesign");
    setData(await doppel().addStyleSources());
    setBusy(null);
  };
  const addFigma = async () => {
    setBusy("figma");
    setError(null);
    const r = await doppel().addStyleFigmaLink(link);
    setBusy(null);
    if (r.ok) {
      setData(r.value);
      setLink("");
    } else setError(r.error.message);
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={copy.style.title} subtitle={copy.style.subtitle} />
      {loading && !profile ? (
        <Loading />
      ) : profile ? (
        <>
          <Section title={copy.style.sourcesTitle}>
            <StyleSources sources={profile.sources} onRemove={async (id) => setData(await doppel().removeStyleSource(id))} />
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={addInDesign} disabled={busy !== null}>
                  {busy === "indesign" ? copy.style.reading : copy.style.addInDesign}
                </Button>
                <span className="ui-small ui-muted">{copy.style.inDesignHint}</span>
              </div>
              <div className="flex max-w-xl gap-2">
                <input
                  className="ui-input"
                  aria-label={copy.style.addFigma}
                  placeholder={copy.style.figmaPlaceholder}
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && link.trim() && addFigma()}
                />
                <Button onClick={addFigma} disabled={!link.trim() || busy !== null}>
                  {busy === "figma" ? copy.style.reading : copy.style.addFigma}
                </Button>
              </div>
              {error && (
                <p className="ui-small" role="alert">
                  {error}
                </p>
              )}
            </div>
          </Section>
          <Section title={copy.style.rulesTitle}>
            <StyleRules rules={profile.rules} />
          </Section>
        </>
      ) : null}
    </div>
  );
}
