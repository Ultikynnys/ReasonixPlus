/** The create-a-pack wizard behind Settings > Sound > New pack.
 *
 *  Two steps, because creating a pack asks exactly two things: what it is called, then
 *  which sound represents each cue. The picked files are the user's own; the daemon copies
 *  them into the pack folder when the draft is submitted. */

import { useEffect, useState } from "react";
import type { FeedbackCueId } from "../protocol";
import { t } from "../i18n";
import { FEEDBACK_CUES } from "./feedback-cue-copy";

export type SoundPackDraft = {
  label: string;
  /** Cue to the absolute path the user picked for it. */
  sounds: Partial<Record<FeedbackCueId, string>>;
};

/** The file name a picked path ends in, shown in place of the full path. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function PackWizard({
  open,
  onClose,
  onPickSound,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  /** Opens the desktop file dialog; resolves to the picked path or null when cancelled. */
  onPickSound: () => Promise<string | null>;
  onCreate: (draft: SoundPackDraft) => void;
}) {
  const [step, setStep] = useState<"name" | "sounds">("name");
  const [label, setLabel] = useState("");
  const [sounds, setSounds] = useState<SoundPackDraft["sounds"]>({});

  // Every open starts a fresh pack: a half-filled draft from last time would be a surprise.
  useEffect(() => {
    if (!open) return;
    setStep("name");
    setLabel("");
    setSounds({});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const named = label.trim().length > 0;
  const chosen = Object.keys(sounds).length;
  const pick = async (cue: FeedbackCueId) => {
    const path = await onPickSound().catch(() => null);
    if (path) setSounds((current) => ({ ...current, [cue]: path }));
  };
  const clear = (cue: FeedbackCueId) => {
    setSounds((current) => {
      const next = { ...current };
      delete next[cue];
      return next;
    });
  };

  return (
    <div className="pack-wizard-mask" role="presentation" onClick={onClose}>
      <div
        className="pack-wizard"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.packWizardTitle")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pack-wizard-head">
          <div className="n">{t("settings.packWizardTitle")}</div>
          <div className="h">
            {step === "name" ? t("settings.packWizardStepName") : t("settings.packWizardStepSounds")}
          </div>
        </div>

        {step === "name" ? (
          <label className="pack-wizard-field">
            <span className="n">{t("settings.packWizardNameLabel")}</span>
            {/* biome-ignore lint/a11y/noAutofocus: the wizard opens on its one question */}
            <input
              className="field"
              autoFocus
              value={label}
              aria-label={t("settings.packWizardNameLabel")}
              placeholder={t("settings.packWizardNamePlaceholder")}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && named) setStep("sounds");
              }}
            />
            <span className="h">{t("settings.packWizardNameHint")}</span>
          </label>
        ) : (
          <>
            <div className="h" style={{ marginBottom: 8 }}>
              {t("settings.packWizardSoundsHint")}
            </div>
            {FEEDBACK_CUES.map(({ id, label: labelKey, hint }) => {
              const path = sounds[id];
              return (
                <div className="pack-wizard-row" key={id}>
                  <div className="l">
                    <div className="n">{t(labelKey)}</div>
                    <div className="h">{t(hint)}</div>
                  </div>
                  <div className="pack-wizard-pick">
                    <span className="pack-wizard-file" title={path ?? undefined}>
                      {path ? fileName(path) : t("settings.packWizardNoSound")}
                    </span>
                    <button
                      type="button"
                      className="btn small"
                      aria-label={t("settings.packWizardChoose", { cue: t(labelKey) })}
                      onClick={() => void pick(id)}
                    >
                      {t("settings.packWizardChooseShort")}
                    </button>
                    {path ? (
                      <button
                        type="button"
                        className="btn small"
                        aria-label={t("settings.packWizardClear", { cue: t(labelKey) })}
                        onClick={() => clear(id)}
                      >
                        {t("settings.packWizardClearShort")}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </>
        )}

        <div className="pack-wizard-foot">
          <button type="button" className="btn" onClick={onClose}>
            {t("settings.packWizardCancel")}
          </button>
          {step === "sounds" ? (
            <button type="button" className="btn" onClick={() => setStep("name")}>
              {t("settings.packWizardBack")}
            </button>
          ) : null}
          {step === "name" ? (
            <button
              type="button"
              className="btn primary"
              disabled={!named}
              onClick={() => setStep("sounds")}
            >
              {t("settings.packWizardNext")}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={chosen === 0}
              onClick={() => {
                onCreate({ label: label.trim(), sounds });
                onClose();
              }}
            >
              {t("settings.packWizardCreate")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
