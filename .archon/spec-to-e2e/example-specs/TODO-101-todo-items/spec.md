# TODO-101: Managing todo items

Jira: TODO-101 · Release 0.1 · Related: TODO-88 (filters)

An example specification for trying the `kiro-spec-to-e2e` workflow against the public
TodoMVC demo at https://demo.playwright.dev/todomvc/. It mixes behaviour a user can see
with technical notes that cannot be checked in a browser, the way real specs do.

## Behaviour

1. A user adds a todo by typing into the "What needs to be done?" field and pressing
   Enter. The new todo appears at the bottom of the list and the field is cleared.
2. Pressing Enter with an empty field, or one holding only spaces, adds nothing.
3. The footer counts the todos that are not completed: "1 item left" for one,
   "2 items left" for two.
4. A user marks a todo as completed with its checkbox. "Clear completed" removes every
   completed todo and keeps the others.
5. Todos are still there after the page is reloaded.

## Technical notes

- Each todo gets its id from `crypto.randomUUID()`.
- The list must re-render in under 16 ms with 500 todos.
- State lives in `localStorage` under the key `react-todos`; the schema is versioned so
  that a later release can migrate it.
