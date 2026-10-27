"use client";

import { StyleRules } from "@/components/style/StyleRules";
import { StyleSources } from "@/components/style/StyleSources";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading } from "@/components/ui/Progress";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useAsync } from "@/lib/hooks";

export default function StylePage() {
  const { data: profile, loading, setData } = useAsync(() => doppel().getStyleProfile(), []);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={copy.style.title} subtitle={copy.style.subtitle} tags={<Tag tone="quiet">{copy.common.comingSoon}</Tag>} />
      <Notice>{copy.style.previewNote}</Notice>
      {loading && !profile ? (
        <Loading />
      ) : profile ? (
        <>
          <Section title={copy.style.sourcesTitle} aside={<Button onClick={async () => setData(await doppel().addStyleSources())}>{copy.style.add}</Button>}>
            <StyleSources sources={profile.sources} onRemove={async (id) => setData(await doppel().removeStyleSource(id))} />
          </Section>
          <Section title={copy.style.rulesTitle}>
            <StyleRules rules={profile.rules} />
          </Section>
        </>
      ) : null}
    </div>
  );
}
