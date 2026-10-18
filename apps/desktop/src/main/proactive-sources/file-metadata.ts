import { basename, extname, relative, resolve } from "node:path";
import { type SupportedPlatform, type ProactiveSourceProbe, type ProactiveCaptureRecord, type ProactiveSourceAdapter, type FileSystemLike, type FullDiskAccessProbe } from "./types";
import { EMPTY_REASON, nowIso, boundedInt, hashPath, normalizeProbe, emptyBatch, makeRecord, uniquePaths, isWithinRoot } from "./shared";

export function createFileMetadataAdapter(input: {
  readonly platform: SupportedPlatform;
  readonly now: () => Date;
  readonly fileSystem: FileSystemLike;
  readonly configuredRoots: readonly string[];
  readonly fullDiskAccessProbe?: FullDiskAccessProbe;
}): ProactiveSourceAdapter {
  const sourceId = "filesystem.full_disk_watch" as const;

  const probe = async (): Promise<ProactiveSourceProbe> => {
    if (input.configuredRoots.length === 0) {
      if (input.fullDiskAccessProbe) {
        try {
          return normalizeProbe(sourceId, input.platform, input.now, await input.fullDiskAccessProbe(), "full_disk_probe_override");
        } catch (error) {
          return normalizeProbe(sourceId, input.platform, input.now, {
            status: "unknown",
            osStatus: "unknown",
            ready: false,
            canRequest: true,
            reason: error instanceof Error ? error.message : "full_disk_probe_failed",
          });
        }
      }
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "prompt",
        osStatus: "unknown",
        ready: false,
        canRequest: true,
        reason: "file_roots_required",
        metadata: { contentDefault: "metadata_only", scanDefault: "disabled" },
      });
    }

    const roots = uniquePaths(input.configuredRoots);
    let readable = 0;
    let denied = 0;
    for (const root of roots) {
      try {
        const original = await input.fileSystem.lstat(root);
        if (original.isSymbolicLink()) {
          denied += 1;
          continue;
        }
        const canonical = await input.fileSystem.realpath(root);
        const stat = await input.fileSystem.lstat(canonical);
        if (stat.isSymbolicLink()) {
          denied += 1;
          continue;
        }
        await input.fileSystem.access(canonical);
        readable += 1;
      } catch {
        denied += 1;
      }
    }
    if (readable === roots.length && roots.length > 0) {
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "granted",
        osStatus: "granted",
        ready: true,
        canRequest: false,
        metadata: {
          rootCount: roots.length,
          roots: roots.map((root) => ({ pathHash: hashPath(root) })),
          contentDefault: "metadata_only",
        },
      });
    }
    return normalizeProbe(sourceId, input.platform, input.now, {
      status: readable > 0 ? "denied" : "denied",
      osStatus: "denied",
      ready: false,
      canRequest: true,
      reason: readable > 0 ? "file_root_scope_partial" : "file_root_access_denied",
      metadata: { rootCount: roots.length, readable, denied },
    });
  };

  return {
    sourceId,
    probe,
    async request() {
      if (input.fullDiskAccessProbe) {
        try {
          await input.fullDiskAccessProbe();
        } catch {
          // Probe below remains authoritative.
        }
      }
      return probe();
    },
    async capture(options = {}) {
      const state = await probe();
      if (!state.ready) return emptyBatch(sourceId, input.now, state.reason ?? EMPTY_REASON);
      const roots = uniquePaths(options.roots ?? input.configuredRoots);
      if (roots.length === 0) return emptyBatch(sourceId, input.now, "file_roots_required");

      // An options-level root may narrow the configured scope, but it may not
      // silently widen it. When a native full-disk probe is the authority and
      // no roots were configured, the explicit roots are covered by that grant.
      if (input.configuredRoots.length > 0 && options.roots) {
        const authorizedRoots: string[] = [];
        for (const configured of uniquePaths(input.configuredRoots)) {
          try {
            const original = await input.fileSystem.lstat(configured);
            if (original.isSymbolicLink()) continue;
            authorizedRoots.push(await input.fileSystem.realpath(configured));
          } catch {
            // The probe below has already made this an unavailable scope.
          }
        }
        for (const requested of roots) {
          let requestedCanonical: string;
          try {
            const original = await input.fileSystem.lstat(requested);
            if (original.isSymbolicLink()) return emptyBatch(sourceId, input.now, "file_root_symlink_denied");
            requestedCanonical = await input.fileSystem.realpath(requested);
          } catch {
            return emptyBatch(sourceId, input.now, "file_root_access_denied");
          }
          if (!authorizedRoots.some((authorized) => isWithinRoot(authorized, requestedCanonical))) {
            return emptyBatch(sourceId, input.now, "file_root_out_of_scope");
          }
        }
      }
      const maxItems = boundedInt(options.maxItems, 200, 1, 5_000);
      const maxDepth = boundedInt(options.maxDepth, 8, 0, 64);
      const signal = options.signal;
      const includePaths = options.includePaths !== false;
      const records: ProactiveCaptureRecord[] = [];
      const queue: Array<{ path: string; root: string; depth: number }> = [];
      const visited = new Set<string>();
      let skipped = 0;

      for (const root of roots) {
        try {
          // Check the user-supplied path before realpath so a symlink root cannot
          // be laundered into an apparently safe canonical target.
          const original = await input.fileSystem.lstat(root);
          if (original.isSymbolicLink()) {
            skipped += 1;
            continue;
          }
          const canonical = await input.fileSystem.realpath(root);
          const stat = await input.fileSystem.lstat(canonical);
          if (stat.isSymbolicLink()) {
            skipped += 1;
            continue;
          }
          queue.push({ path: canonical, root: canonical, depth: 0 });
        } catch {
          skipped += 1;
        }
      }

      while (queue.length > 0 && records.length < maxItems) {
        if (signal?.aborted) {
          return {
            sourceId,
            capturedAt: nowIso(input.now),
            records,
            complete: false,
            nextCursor: queue[0]?.path,
            skipped,
            reason: "capture_aborted",
          };
        }
        const item = queue.shift();
        if (!item) break;
        let canonical: string;
        try {
          const original = await input.fileSystem.lstat(item.path);
          if (original.isSymbolicLink()) {
            skipped += 1;
            continue;
          }
          canonical = await input.fileSystem.realpath(item.path);
          if (!isWithinRoot(item.root, canonical) || visited.has(canonical)) {
            skipped += 1;
            continue;
          }
          visited.add(canonical);
          const stat = await input.fileSystem.lstat(canonical);
          if (stat.isSymbolicLink()) {
            skipped += 1;
            continue;
          }
          const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
          records.push(makeRecord(sourceId, "filesystem.metadata", input.now, {
            ...(includePaths ? { path: canonical } : {}),
            pathHash: hashPath(canonical),
            relativePath: relative(item.root, canonical),
            kind,
            size: stat.size,
            modifiedAt: Number.isFinite(stat.mtimeMs) ? new Date(stat.mtimeMs).toISOString() : undefined,
            createdAt: stat.birthtimeMs !== undefined && Number.isFinite(stat.birthtimeMs)
              ? new Date(stat.birthtimeMs).toISOString()
              : undefined,
            mode: stat.mode,
            extension: kind === "file" ? extname(basename(canonical)).toLowerCase() || undefined : undefined,
            adapter: "filesystem-metadata-v1",
            contentOmitted: true,
          }));

          if (stat.isDirectory() && item.depth < maxDepth) {
            const entries = (await input.fileSystem.readdir(canonical)).slice().sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
              if (entry.isSymbolicLink()) {
                skipped += 1;
                continue;
              }
              const child = resolve(canonical, entry.name);
              if (!isWithinRoot(item.root, child)) {
                skipped += 1;
                continue;
              }
              queue.push({ path: child, root: item.root, depth: item.depth + 1 });
            }
          }
        } catch {
          skipped += 1;
        }
      }

      const complete = queue.length === 0;
      return {
        sourceId,
        capturedAt: nowIso(input.now),
        records,
        complete,
        nextCursor: complete ? undefined : queue[0]?.path,
        skipped,
        reason: records.length === 0 ? "file_metadata_unavailable" : undefined,
      };
    },
  };
}
