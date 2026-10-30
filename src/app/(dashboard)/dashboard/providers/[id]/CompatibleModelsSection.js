"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import { translate } from "@/i18n/runtime";

// ponytail: free tier is only marked in the id/name upstream (no pricing in /models),
// so it is a suffix heuristic. Upgrade path: ask the /models route for a priced `isFree` flag.
const FREE_ID_RE = /(^|[^a-z0-9])free([^a-z0-9]|$)/i;

function CompatibleModelRow({ modelId, fullModel, copied, onCopy, onDeleteAlias, onTest, testStatus, isTesting, selectable, selected, onSelect }) {
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border";

  const iconColor = testStatus === "ok"
    ? "#22c55e"
    : testStatus === "error"
    ? "#ef4444"
    : undefined;

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border ${borderColor} hover:bg-sidebar/50`}>
      {selectable && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          aria-label={`Select ${modelId} for removal`}
          className="h-4 w-4 accent-red-500"
        />
      )}
      <span
        className="material-symbols-outlined text-base text-text-muted"
        style={iconColor ? { color: iconColor } : undefined}
      >
        {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{modelId}</p>
        <div className="flex items-center gap-1 mt-1">
          <code className="text-xs text-text-muted font-mono bg-sidebar px-1.5 py-0.5 rounded">{fullModel}</code>
          <div className="relative group/btn">
            <button
              onClick={() => onCopy(fullModel, `model-${modelId}`)}
              className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary"
            >
              <span className="material-symbols-outlined text-sm">
                {copied === `model-${modelId}` ? "check" : "content_copy"}
              </span>
            </button>
            <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {copied === `model-${modelId}` ? "Copied!" : "Copy"}
            </span>
          </div>
          {onTest && (
            <div className="relative group/btn">
              <button
                onClick={onTest}
                disabled={isTesting}
                className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                  {isTesting ? "progress_activity" : "science"}
                </span>
              </button>
              <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {isTesting ? "Testing..." : "Test"}
              </span>
            </div>
          )}
        </div>
      </div>
      {!selectable && (
        <button
          onClick={onDeleteAlias}
          className="p-1 hover:bg-red-50 rounded text-red-500"
          title="Remove model"
        >
          <span className="material-symbols-outlined text-sm">delete</span>
        </button>
      )}
    </div>
  );
}

export default function CompatibleModelsSection({ providerStorageAlias, providerDisplayAlias, modelAliases, customModels, copied, onCopy, onDeleteAlias, onAddCustomModels, onDeleteCustomModels, connections, isAnthropic }) {
  const [newModel, setNewModel] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(null); // null | "all" | "free"
  // A Set, not a single id: several model pings run at once.
  const [testingModelIds, setTestingModelIds] = useState(() => new Set());
  const [modelTestResults, setModelTestResults] = useState({});
  const [bulkRemoving, setBulkRemoving] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [removing, setRemoving] = useState(false);

  const handleTestModel = async (modelId) => {
    if (testingModelIds.has(modelId)) return;
    setTestingModelIds((prev) => new Set(prev).add(modelId));
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}` }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
    } finally {
      setTestingModelIds((prev) => { const n = new Set(prev); n.delete(modelId); return n; });
    }
  };

  const allModels = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    type: "llm",
  });

  // Only imported models (source "custom") are bulk-removable; legacy aliases keep their single delete.
  const removableIds = allModels.filter((m) => m.source === "custom").map((m) => m.id);

  const handleAdd = async () => {
    if (!newModel.trim() || adding) return;
    const modelId = newModel.trim();
    if (allModels.some((model) => model.id === modelId)) {
      alert("Model already exists for this provider.");
      return;
    }

    setAdding(true);
    try {
      await onAddCustomModels([modelId]);
      setNewModel("");
    } catch (error) {
      console.log("Error adding model:", error);
    } finally {
      setAdding(false);
    }
  };

  const fetchLiveModels = async () => {
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    if (!activeConnection) return null;

    const res = await fetch(`/api/providers/${activeConnection.id}/models`);
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Failed to fetch models");
      return null;
    }
    return data.models || [];
  };

  const handleImport = async (freeOnly) => {
    if (importing) return;
    const models = await fetchLiveModels();
    if (models === null) return;
    if (models.length === 0) {
      alert("No models returned from /models.");
      return;
    }

    setImporting(freeOnly ? "free" : "all");
    try {
      const known = new Set(allModels.map((entry) => entry.id));
      const ids = [...new Set(models
        .filter((model) => !freeOnly || FREE_ID_RE.test(model.id || model.model || "") || FREE_ID_RE.test(model.name || ""))
        .map((model) => model.id || model.name || model.model)
        .filter((modelId) => typeof modelId === "string" && modelId && !known.has(modelId)))];

      if (ids.length === 0) {
        alert(freeOnly ? "No new free models were found." : "No new models were added.");
        return;
      }
      await onAddCustomModels(ids);
    } catch (error) {
      console.log("Error importing models:", error);
    } finally {
      setImporting(null);
    }
  };

  const toggleBulkMode = () => {
    // Entering select mode preselects every imported model.
    setSelectedIds(bulkRemoving ? new Set() : new Set(removableIds));
    setBulkRemoving(!bulkRemoving);
  };

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleBulkRemove = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0 || removing) return;
    if (!confirm(`${translate("Remove")} ${ids.length} ${translate("imported models")}?`)) return;
    setRemoving(true);
    try {
      await onDeleteCustomModels(ids);
      setBulkRemoving(false);
      setSelectedIds(new Set());
    } catch (error) {
      console.log("Error removing models:", error);
    } finally {
      setRemoving(false);
    }
  };

  const canImport = connections.some((conn) => conn.isActive !== false);
  const selectableCount = selectedIds.size;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Add {isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually or import them from the /models endpoint.
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="new-compatible-model-input" className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            id="new-compatible-model-input"
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder={isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
        </div>
        <Button size="sm" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? "Adding..." : "Add"}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={() => handleImport(false)} disabled={!canImport || !!importing}>
          {importing === "all" ? "Importing..." : "Import from /models"}
        </Button>
        <Button size="sm" variant="secondary" icon="bolt" onClick={() => handleImport(true)} disabled={!canImport || !!importing}>
          {importing === "free" ? "Importing..." : translate("Import free models")}
        </Button>
        {removableIds.length > 0 && !bulkRemoving && (
          <Button size="sm" variant="ghost" icon="delete_group" onClick={toggleBulkMode}>
            {translate("Bulk remove imported")}
          </Button>
        )}
      </div>

      {!canImport && (
        <p className="text-xs text-text-muted">
          Add a connection to enable importing models.
        </p>
      )}

      {allModels.length > 0 && (
        <div className="flex flex-col gap-3">
          {bulkRemoving && (
            <div className="flex items-center gap-2 flex-wrap rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
              <label className="flex items-center gap-2 text-xs text-text-main">
                <input
                  type="checkbox"
                  checked={selectableCount === removableIds.length && removableIds.length > 0}
                  onChange={() => setSelectedIds(selectableCount === removableIds.length ? new Set() : new Set(removableIds))}
                />
                {translate("Select all (imported models only)")}
              </label>
              <Button size="xs" variant="danger" icon="delete" onClick={handleBulkRemove} disabled={selectableCount === 0 || removing}>
                {removing ? translate("Removing...") : `${translate("Remove selected")} (${selectableCount})`}
              </Button>
              <Button size="xs" variant="ghost" onClick={toggleBulkMode} disabled={removing}>{translate("Cancel")}</Button>
            </div>
          )}
          {allModels.map(({ id, alias, source }) => (
            <CompatibleModelRow
              key={`${source}-${providerStorageAlias}/${id}`}
              modelId={id}
              fullModel={`${providerDisplayAlias}/${id}`}
              copied={copied}
              onCopy={onCopy}
              onDeleteAlias={() => source === "custom" ? onDeleteCustomModels([id]) : onDeleteAlias(alias)}
              onTest={connections.length > 0 ? () => handleTestModel(id) : undefined}
              testStatus={modelTestResults[id]}
              isTesting={testingModelIds.has(id)}
              selectable={bulkRemoving && source === "custom"}
              selected={selectedIds.has(id)}
              onSelect={() => toggleSelected(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  providerStorageAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  modelAliases: PropTypes.object.isRequired,
  customModels: PropTypes.arrayOf(PropTypes.object),
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onAddCustomModels: PropTypes.func.isRequired,
  onDeleteCustomModels: PropTypes.func.isRequired,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  isAnthropic: PropTypes.bool,
};
