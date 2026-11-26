// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectMenu } from "./SelectMenu";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(cleanup);

it("can select a run and return to the latest-run option without leaking an internal value", async () => {
  const changed = vi.fn();
  function Form() {
    const [value, setValue] = useState("");
    return <SelectMenu label="Execução" value={value} options={[{ value: "", label: "Mais recente" }, { value: "run-1", label: "Execução 1" }]}
      onChange={next=>{setValue(next);changed(next);}}/>;
  }
  render(<Form/>);
  const trigger = screen.getByRole("combobox", { name: "Execução" });
  expect(trigger.textContent).toBe("Mais recente");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await userEvent.click(await screen.findByRole("option", { name: "Execução 1" }));
  expect(changed).toHaveBeenLastCalledWith("run-1");
  expect(trigger.textContent).toBe("Execução 1");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await userEvent.click(await screen.findByRole("option", { name: "Mais recente" }));
  expect(changed).toHaveBeenLastCalledWith("");
  expect(trigger.textContent).toBe("Mais recente");
});

it("keeps an empty selector labeled and disabled with an explanatory placeholder", () => {
  render(<SelectMenu label="Tracking" value="" options={[]} onChange={vi.fn()} placeholder="Conclua um tracking"/>);
  const trigger = screen.getByRole("combobox", { name: "Tracking" }) as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
  expect(trigger.textContent).toBe("Conclua um tracking");
});

it("does not offer interaction when every option is disabled", () => {
  render(<SelectMenu label="Execução" value="" options={[{value:"pending",label:"Em processamento",disabled:true}]} onChange={vi.fn()}/>);
  expect((screen.getByRole("combobox", { name: "Execução" }) as HTMLButtonElement).disabled).toBe(true);
});
