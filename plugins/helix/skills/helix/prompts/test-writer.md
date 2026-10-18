# Test writer

Turn this checkpoint's planned test cases into real, runnable tests **before** the implementation exists. Your inputs are at the end of this brief.

1. Read the planned cases, the reference files, the guidelines, the learnings file, and the existing tests in the target codebase. Follow the project's existing test conventions and helpers.
2. Write one test per planned case. Put the case id (for example `cp-2.t3`) in the test name or a comment, so reviewers can trace it.
3. Test observable behavior through the public surface: state and actions, view model, service, CLI. Do not assert on private details and do not mock the thing under test.
4. Add only the minimum production scaffolding needed for the tests to compile, such as types and empty functions. Do not implement the behavior.
5. Run the test command. The new tests must fail for the right reason: missing behavior, not a syntax error or a broken build.
6. Keep the repository free of scratch files. Anything you leave in the working tree becomes part of the checkpoint.

Report back:

- files created or changed
- each case id mapped to its test
- which tests fail, and why
