import { mount, type Props } from "@xazzzi/gg";
import {
  COUNTRIES,
  FEATURES,
  form,
  LANGUAGES,
  PLANS,
  randomize,
  reset,
  type Values,
} from "./form.ts";

type Keys<T> = {
  [K in keyof Values]: Values[K] extends T ? K : never;
}[keyof Values];

// Each control sets its first value through a live property, writes the form on input,
// then follows the form, except while it has focus, so typing "3." in a number survives.

async function* TextField({
  field,
  ...attrs
}: { field: Keys<string> } & Props) {
  const input = (
    <input
      {...attrs}
      value={form[field]}
      oninput={() => (form[field] = input.value)}
    />
  ) as HTMLInputElement;
  yield input;
  for await (const values of form)
    if (input !== document.activeElement) input.value = values[field];
}

async function* TextArea({ field, ...attrs }: { field: Keys<string> } & Props) {
  const area = (
    <textarea
      {...attrs}
      value={form[field]}
      oninput={() => (form[field] = area.value)}
    />
  ) as HTMLTextAreaElement;
  yield area;
  for await (const values of form)
    if (area !== document.activeElement) area.value = values[field];
}

async function* NumberField({
  field,
  ...attrs
}: { field: Keys<number> } & Props) {
  const input = (
    <input
      {...attrs}
      value={form[field]}
      oninput={() => (form[field] = input.valueAsNumber)}
    />
  ) as HTMLInputElement;
  yield input;
  for await (const values of form)
    if (input !== document.activeElement) input.valueAsNumber = values[field];
}

async function* Toggle({ field }: { field: Keys<boolean> }) {
  const box = (
    <input
      type="checkbox"
      checked={form[field]}
      onchange={() => (form[field] = box.checked)}
    />
  ) as HTMLInputElement;
  yield box;
  for await (const values of form) box.checked = values[field];
}

async function* Radio({
  field,
  value,
}: {
  field: Keys<string>;
  value: string;
}) {
  const radio = (
    <input
      type="radio"
      name={field}
      value={value}
      checked={form[field] === value}
      onchange={() => (form[field] = value)}
    />
  ) as HTMLInputElement;
  yield radio;
  for await (const values of form) radio.checked = values[field] === value;
}

async function* Choice({
  field,
  options,
}: {
  field: Keys<string>;
  options: string[];
}) {
  // value finds its option, because JSX assigns it after the children (JX-002).
  const select = (
    <select value={form[field]} onchange={() => (form[field] = select.value)}>
      {options.map(option => (
        <option>{option}</option>
      ))}
    </select>
  ) as HTMLSelectElement;
  yield select;
  for await (const values of form)
    if (select !== document.activeElement) select.value = values[field];
}

async function* MultiChoice({
  field,
  options,
}: {
  field: Keys<string[]>;
  options: string[];
}) {
  const select = (
    <select
      multiple
      size={options.length}
      onchange={() =>
        (form[field] = [...select.selectedOptions].map(option => option.value))
      }
    >
      {options.map(option => (
        <option selected={form[field].includes(option)}>{option}</option>
      ))}
    </select>
  ) as HTMLSelectElement;
  yield select;
  for await (const values of form)
    for (const option of select.options)
      option.selected = values[field].includes(option.value);
}

async function* Member({
  field,
  value,
}: {
  field: Keys<string[]>;
  value: string;
}) {
  const box = (
    <input
      type="checkbox"
      checked={form[field].includes(value)}
      onchange={() =>
        (form[field] = box.checked
          ? [...form[field], value]
          : form[field].filter(item => item !== value))
      }
    />
  ) as HTMLInputElement;
  yield box;
  for await (const values of form) box.checked = values[field].includes(value);
}

async function* AllMembers({
  field,
  options,
}: {
  field: Keys<string[]>;
  options: string[];
}) {
  const some = (chosen: string[]) =>
    chosen.length > 0 && chosen.length < options.length;
  const box = (
    <input
      type="checkbox"
      checked={form[field].length === options.length}
      indeterminate={some(form[field])}
      onchange={() => (form[field] = box.checked ? [...options] : [])}
    />
  ) as HTMLInputElement;
  yield box;
  for await (const values of form) {
    box.checked = values[field].length === options.length;
    box.indeterminate = some(values[field]);
  }
}

async function* Live({ format }: { format: (values: Values) => string }) {
  for await (const values of form) yield format(values);
}

mount(
  document.querySelector("main") as Element,
  <div class="form">
    <label class="row">
      <span>Name</span>
      <TextField field="name" type="text" />
    </label>
    <label class="row">
      <span>Bio</span>
      <TextArea field="bio" rows="3" />
    </label>
    <label class="row">
      <span>Age</span>
      <NumberField field="age" type="number" min="0" max="150" />
    </label>
    <label class="row">
      <span>Volume</span>
      <NumberField field="volume" type="range" min="0" max="100" />
      <output>
        <Live format={values => `${values.volume}`} />
      </output>
    </label>
    <label class="row">
      <span>Color</span>
      <TextField field="color" type="color" />
    </label>
    <label class="row">
      <span>Date</span>
      <TextField field="date" type="date" />
    </label>
    <fieldset>
      <legend>Plan</legend>
      {PLANS.map(plan => (
        <label>
          <Radio field="plan" value={plan} />
          {plan}
        </label>
      ))}
    </fieldset>
    <label class="row">
      <span>Country</span>
      <Choice field="country" options={COUNTRIES} />
    </label>
    <fieldset>
      <legend>Features</legend>
      <label>
        <AllMembers field="features" options={FEATURES} />
        <b>all</b>
      </label>
      {FEATURES.map(feature => (
        <label>
          <Member field="features" value={feature} />
          {feature}
        </label>
      ))}
    </fieldset>
    <label class="row">
      <span>Languages</span>
      <MultiChoice field="languages" options={LANGUAGES} />
    </label>
    <label class="check">
      <Toggle field="newsletter" />
      Newsletter
    </label>
    <div class="buttons">
      <button type="button" onclick={reset}>
        Reset
      </button>
      <button type="button" onclick={randomize}>
        Randomize
      </button>
    </div>
  </div>,
  <pre class="state">
    <Live format={values => JSON.stringify(values, null, 2)} />
  </pre>,
);
