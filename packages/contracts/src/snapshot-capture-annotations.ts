import type { ObserveOnlyEvidence, SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import type { AndroidSnapshotBackendMetadata } from './snapshot-types.ts';

export function readObserveOnlyEvidence(value: unknown): ObserveOnlyEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const observation = value as Record<string, unknown>;
  if (
    observation.mode !== 'observe-only' ||
    observation.capability !== 'non-activating-foreground-v1' ||
    observation.foregroundVerified !== true ||
    typeof observation.targetAppBundleId !== 'string' ||
    observation.targetAppBundleId.trim().length === 0
  )
    return undefined;
  return {
    mode: 'observe-only',
    capability: 'non-activating-foreground-v1',
    foregroundVerified: true,
    targetAppBundleId: observation.targetAppBundleId,
  };
}

export type SnapshotCaptureAnalysis = {
  rawNodeCount: number;
  maxDepth: number;
};

export type SnapshotCaptureFreshness = {
  action: string;
  retryCount: number;
  staleAfterRetries: boolean;
  reason?: 'empty-interactive' | 'sharp-drop' | 'stuck-route';
};

export type SnapshotCaptureAnnotations = {
  observation?: ObserveOnlyEvidence;
  analysis?: SnapshotCaptureAnalysis;
  androidSnapshot?: AndroidSnapshotBackendMetadata;
  freshness?: SnapshotCaptureFreshness;
  quality?: SnapshotQualityVerdict;
  warnings?: string[];
};

export type PublicSnapshotCaptureAnnotations = Pick<
  SnapshotCaptureAnnotations,
  'androidSnapshot' | 'observation' | 'warnings'
> & {
  snapshotQuality?: SnapshotQualityVerdict;
};

export function snapshotCaptureAnnotationsFrom(
  source: Partial<Omit<SnapshotCaptureAnnotations, 'quality'>> & { quality?: unknown },
): SnapshotCaptureAnnotations {
  const quality = readSnapshotQualityVerdict(source.quality);
  return {
    ...(source.observation ? { observation: source.observation } : {}),
    ...(source.analysis ? { analysis: source.analysis } : {}),
    ...(source.androidSnapshot ? { androidSnapshot: source.androidSnapshot } : {}),
    ...(source.freshness ? { freshness: source.freshness } : {}),
    ...(quality ? { quality } : {}),
    ...(source.warnings ? { warnings: source.warnings } : {}),
  };
}

export function publicSnapshotCaptureAnnotations(
  annotations: Partial<SnapshotCaptureAnnotations>,
): PublicSnapshotCaptureAnnotations {
  return {
    ...(annotations.observation ? { observation: annotations.observation } : {}),
    ...(annotations.androidSnapshot ? { androidSnapshot: annotations.androidSnapshot } : {}),
    ...(annotations.quality ? { snapshotQuality: annotations.quality } : {}),
    ...(annotations.warnings && annotations.warnings.length > 0
      ? { warnings: annotations.warnings }
      : {}),
  };
}

export function readSerializedSnapshotCaptureAnnotations(
  data: Record<string, unknown>,
): PublicSnapshotCaptureAnnotations {
  const observation = readObserveOnlyEvidence(data.observation);
  const androidSnapshot = readObject(data.androidSnapshot);
  const warnings = Array.isArray(data.warnings)
    ? data.warnings.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const quality = readSnapshotQualityVerdict(data.snapshotQuality);
  return publicSnapshotCaptureAnnotations({
    ...(observation ? { observation } : {}),
    ...(androidSnapshot
      ? { androidSnapshot: androidSnapshot as AndroidSnapshotBackendMetadata }
      : {}),
    ...(quality ? { quality } : {}),
    ...(warnings ? { warnings } : {}),
  });
}

function readSnapshotQualityVerdict(value: unknown): SnapshotQualityVerdict | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw.state === 'string' && typeof raw.backend === 'string'
    ? (raw as SnapshotQualityVerdict)
    : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
