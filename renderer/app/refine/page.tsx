"use client";

import type { RefineSetup } from "@core/types";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { QcChecks } from "@/components/results/QcChecks";
import { RoutineBadges } from "@/components/routine/ContractView";
import { Details } from "@/components/common/Details";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PageHeader } from "@/components/common/PageHeader";
import { Preview } from "@/components/common/Preview";
import { Loading } from "@/components/common/Progress";
import { Section } from "@/components/common/Section";
import { Tag } from "@/components/common/Tag";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { fileName } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/common/ButtonLink";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";

const MAX_TEST_ITEMS = 3;
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "heic"];

function RefineForm({ setup, flowLink, initialRequest = "" }: { setup: RefineSetup; flowLink?: { flowId: string; nodeId: string }; initialRequest?: string }) {
  const router = useRouter();
  const { routine, problem } = setup;
  const [request, setRequest] = useState(initialRequest);
  const [images, setImages] = useState<string[]>([]);
  const [items, setItems] = useState<string[]>(setup.defaultItems);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: string) =>
    setItems((list) => (list.includes(key) ? list.filter((k) => k !== key) : list.length >= MAX_TEST_ITEMS ? list : [...list, key]));
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const creation = await doppel().refineRoutine({
        routineId: routine.id,
        request,
        images,
        testItems: items,
        ...(problem ? { problem: { runId: problem.runId, outputId: problem.outputId } } : {}),
        ...(flowLink ? { flowLink } : {}),
      });
      router.push(`/create?task=${creation.id}`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        <Section title={copy.refine.requestLabel}>
          <Textarea
            id="refine-request"
            className="h-32"
            aria-label={copy.refine.requestLabel}
            placeholder={copy.refine.requestPlaceholder}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
          />
          <p className="text-sm text-muted-foreground">{copy.refine.requestHint}</p>
        </Section>

        <Section title={copy.refine.attachmentsTitle}>
          {problem && (
            <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row">
              <div className="sm:w-56">
                <Preview preview={problem.preview} status={problem.preview ? undefined : copy.common.noPreview} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag tone="strong">{copy.refine.problemTag}</Tag>
                  <span className="text-sm font-medium">{problem.label}</span>
                </div>
                {problem.itemLabel && <span className="text-sm text-muted-foreground">{copy.refine.fromItem(problem.itemLabel)}</span>}
                {problem.input && problem.input !== problem.itemLabel && <span className="text-sm text-muted-foreground truncate">{copy.refine.input(problem.input)}</span>}
                {problem.error && <span className="text-sm">{problem.error}</span>}
                <Details text={problem.errorDetail} />
                {problem.qc && <QcChecks checks={problem.qc.checks} />}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline"
              onClick={async () => {
                const files = await doppel().pickFiles({ extensions: IMAGE_EXTENSIONS, multiple: true });
                if (files.length) setImages((list) => [...new Set([...list, ...files])].slice(0, 3));
              }}
              disabled={images.length >= 3}
            >
              {copy.refine.addImages}
            </Button>
            <span className="text-sm text-muted-foreground">{copy.refine.imagesHint}</span>
          </div>
          {images.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {images.map((f) => (
                <li key={f} className="text-sm flex items-center gap-3">
                  <span className="truncate">{fileName(f)}</span>
                  <Button variant="link" className="h-auto p-0" onClick={() => setImages((list) => list.filter((x) => x !== f))}>
                    {copy.newTask.remove}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <Section title={copy.refine.testItemsTitle}>
          {setup.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.refine.noItems}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{copy.refine.testItemsHint(setup.itemsSource ?? "")}</p>
              <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
                {setup.items.map((i) => (
                  <li key={i.key}>
                    <label className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground" data-disabled={!items.includes(i.key) && items.length >= MAX_TEST_ITEMS}>
                      <Checkbox className="mt-0.5" checked={items.includes(i.key)} disabled={!items.includes(i.key) && items.length >= MAX_TEST_ITEMS} onCheckedChange={() => toggle(i.key)} />
                      <span>
                        {i.label}
                        {problem?.itemKey === i.key && <span className="text-sm text-muted-foreground"> · {copy.refine.problemTag.toLowerCase()}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>

        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={start} disabled={!request.trim() || starting}>
            {starting ? copy.newTask.creating : copy.refine.start}
          </Button>
          <span className="text-sm text-muted-foreground">{copy.refine.costHint}</span>
        </div>
      </div>
    </div>
  );
}

function RefineScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const routineId = params.get("routine");
  const runId = params.get("run");
  const outputId = params.get("output");
  const flowId = params.get("flow");
  const nodeId = params.get("node");
  const [setup, setSetup] = useState<RefineSetup | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!routineId) return;
    doppel()
      .getRefineSetup(routineId, runId && outputId ? { runId, outputId } : undefined, flowId && nodeId ? { flowId, nodeId } : undefined)
      .then(setSetup)
      .catch((e) => setError((e as Error).message));
  }, [routineId, runId, outputId, flowId, nodeId]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (setup === undefined) return <Loading />;
  if (!setup) return <EmptyState title={copy.common.notFound} action={<ButtonLink href="/routines">{copy.nav.library}</ButtonLink>} />;
  const { routine } = setup;
  const back = flowId ? { href: `/flow?id=${flowId}`, label: copy.results.backToFlow } : { href: `/routine?id=${routine.id}`, label: routine.name };
  const query = (id: string) =>
    [`routine=${id}`, runId && outputId ? `run=${runId}&output=${outputId}` : "", flowId && nodeId ? `flow=${flowId}&node=${nodeId}` : ""].filter(Boolean).join("&");

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        back={back}
        title={copy.refine.title(routine.name)}
        tags={
          <>
            <RoutineBadges appId={routine.appId} starter={!!routine.starter} />
            <Tag>{copy.common.version(routine.version)}</Tag>
          </>
        }
        subtitle={copy.refine.subtitle}
      />
      {routine.starter ? (
        <Notice
          title={copy.refine.starterTitle}
          actions={
            <Button
              onClick={async () => {
                const dup = await doppel().duplicateRoutine(routine.id);
                router.replace(`/refine?${query(dup.id)}`);
              }}
            >
              {copy.refine.duplicateAndRefine}
            </Button>
          }
        >
          {copy.refine.starterBody}
        </Notice>
      ) : (
        <RefineForm key={routine.id} setup={setup} flowLink={flowId && nodeId ? { flowId, nodeId } : undefined} initialRequest={params.get("request") ?? ""} />
      )}
    </div>
  );
}

export default function RefinePage() {
  return (
    <Suspense fallback={<Loading />}>
      <RefineScreen />
    </Suspense>
  );
}
