// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./Button";

afterEach(cleanup);

it("loading prevents clicks and duplicate form submissions until the operation finishes", async () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  const user = userEvent.setup();
  const { rerender } = render(<form onSubmit={submit}><Button type="submit" loading>Salvar</Button></form>);
  await user.dblClick(screen.getByRole("button", { name: "Salvar" }));
  expect(submit).not.toHaveBeenCalled();
  rerender(<form onSubmit={submit}><Button type="submit">Salvar</Button></form>);
  await user.click(screen.getByRole("button", { name: "Salvar" }));
  expect(submit).toHaveBeenCalledTimes(1);
});

it("the caller's disabled state remains effective when loading finishes", async () => {
  const onClick = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(<Button loading disabled onClick={onClick}>Iniciar</Button>);
  rerender(<Button loading={false} disabled onClick={onClick}>Iniciar</Button>);
  await user.click(screen.getByRole("button", { name: "Iniciar" }));
  expect(onClick).not.toHaveBeenCalled();
});
