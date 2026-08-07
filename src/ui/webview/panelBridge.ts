import type { TodoItem } from "../../adapters/types";

let refreshHandler: () => void = () => undefined;
let renderTodosHandler: (todos: TodoItem[]) => void = () => undefined;
let todoMarkHandler: (status: TodoItem["status"]) => Element = () => document.createElement("span");

export function registerPanelBridge(handlers: {
    refresh: () => void;
    renderTodos: (todos: TodoItem[]) => void;
    todoMark: (status: TodoItem["status"]) => Element;
}): void {
    refreshHandler = handlers.refresh;
    renderTodosHandler = handlers.renderTodos;
    todoMarkHandler = handlers.todoMark;
}

export const refreshPanelLayout = (): void => refreshHandler();
export const renderPanelTodos = (todos: TodoItem[]): void => renderTodosHandler(todos);
export const renderTodoMark = (status: TodoItem["status"]): Element => todoMarkHandler(status);
