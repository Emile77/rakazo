import { Trans } from "@lingui/react/macro";
import { Field, FieldLabel, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

/** Account-wide selection, using only models advertised by an existing connection. */
export function LiveCallModel() {
  const rpc = useSpaceRpc();
  const id = useId();
  const [choices, setChoices] = useState<
    { value: string; label: string; credentialId: string; model: string }[]
  >([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([rpc.liveMedia.settings(), rpc.models.credentials()])
      .then(async ([selected, connections]) => {
        const lists = await Promise.all(
          connections.map(async (connection) => {
            const models = await rpc.models
              .liveModels({ credentialId: connection.id })
              .catch(() => []);
            return models
              .filter(
                (model) =>
                  model.capabilities?.audioInput &&
                  model.capabilities.audioOutput &&
                  model.capabilities.toolCalls,
              )
              .map((model) => ({
                value: JSON.stringify([connection.id, model.id]),
                label: connection.label + " · " + model.name,
                credentialId: connection.id,
                model: model.id,
              }));
          }),
        );
        if (!active) return;
        setChoices(lists.flat());
        if (selected) setValue(JSON.stringify([selected.credentialId, selected.model]));
      })
      .catch((reason) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, [rpc]);
  if (!choices.length && !error && !value) return null;
  return (
    <Field className="mt-6">
      <FieldLabel htmlFor={id}>
        <Trans>Live call model</Trans>
      </FieldLabel>
      <NativeSelect
        id={id}
        value={value}
        disabled={saving}
        onChange={(event) => {
          const choice = choices.find((item) => item.value === event.target.value);
          if (!choice) {
            setSaving(true);
            void rpc.liveMedia
              .clear()
              .then(() => setValue(""))
              .catch((reason) => setError(errorText(reason)))
              .finally(() => setSaving(false));
            return;
          }
          setSaving(true);
          setError("");
          void rpc.liveMedia
            .select({ credentialId: choice.credentialId, model: choice.model })
            .then(() => setValue(choice.value))
            .catch((reason) => setError(errorText(reason)))
            .finally(() => setSaving(false));
        }}
      >
        <NativeSelectOption value="">
          <Trans>Default voice</Trans>
        </NativeSelectOption>
        {value && !choices.some((choice) => choice.value === value) && (
          <NativeSelectOption value={value} disabled>
            {JSON.parse(value)[1]}
          </NativeSelectOption>
        )}
        {choices.map((choice) => (
          <NativeSelectOption key={choice.value} value={choice.value}>
            {choice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {error && <p role="alert">{error}</p>}
    </Field>
  );
}
