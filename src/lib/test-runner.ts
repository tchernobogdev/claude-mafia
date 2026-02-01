import { execFile } from "child_process";

const DEFAULT_TEST_TIMEOUT_MS = 60_000;

export interface TestCaseResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  error?: string;
  duration?: number; // milliseconds
}

export interface TestRunResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  errors: string[];
  testCases: TestCaseResult[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type TestFramework = "jest" | "vitest" | "pytest" | "mocha";

interface RunTestsOptions {
  framework: TestFramework;
  workingDirectory: string;
  testPath?: string; // Specific test file or pattern
  timeout?: number;
}

/**
 * Execute tests using the specified framework and parse results into structured format.
 */
export async function runTests({
  framework,
  workingDirectory,
  testPath,
  timeout = DEFAULT_TEST_TIMEOUT_MS,
}: RunTestsOptions): Promise<TestRunResult> {
  const command = getTestCommand(framework, testPath);

  return new Promise((resolve) => {
    const [cmd, ...args] = command;

    const proc = execFile(
      cmd,
      args,
      {
        timeout,
        cwd: workingDirectory,
        maxBuffer: 2 * 1024 * 1024,
        shell: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error
          ? ((error as NodeJS.ErrnoException & { code?: number }).code as unknown as number) || 1
          : 0;

        // Parse test output based on framework
        const parsed = parseTestOutput(framework, stdout, stderr, exitCode);

        resolve({
          ...parsed,
          stdout,
          stderr,
          exitCode,
        });
      }
    );

    setTimeout(() => {
      try { proc.kill(); } catch {}
    }, timeout + 1000);
  });
}

function getTestCommand(framework: TestFramework, testPath?: string): string[] {
  switch (framework) {
    case "jest":
      return testPath
        ? ["npx", "jest", testPath, "--json", "--testLocationInResults"]
        : ["npx", "jest", "--json", "--testLocationInResults"];

    case "vitest":
      return testPath
        ? ["npx", "vitest", "run", testPath, "--reporter=json"]
        : ["npx", "vitest", "run", "--reporter=json"];

    case "pytest":
      return testPath
        ? ["pytest", testPath, "--json-report", "--json-report-file=-"]
        : ["pytest", "--json-report", "--json-report-file=-"];

    case "mocha":
      return testPath
        ? ["npx", "mocha", testPath, "--reporter", "json"]
        : ["npx", "mocha", "--reporter", "json"];

    default:
      return ["echo", "Unsupported test framework"];
  }
}

function parseTestOutput(
  framework: TestFramework,
  stdout: string,
  stderr: string,
  exitCode: number
): Omit<TestRunResult, "stdout" | "stderr" | "exitCode"> {
  try {
    switch (framework) {
      case "jest":
        return parseJestOutput(stdout, stderr);
      case "vitest":
        return parseVitestOutput(stdout, stderr);
      case "pytest":
        return parsePytestOutput(stdout, stderr);
      case "mocha":
        return parseMochaOutput(stdout, stderr);
      default:
        return createEmptyResult();
    }
  } catch (err) {
    // Parsing failed - return raw error
    return {
      passed: 0,
      failed: exitCode !== 0 ? 1 : 0,
      skipped: 0,
      total: exitCode !== 0 ? 1 : 0,
      errors: [`Failed to parse ${framework} output: ${err instanceof Error ? err.message : String(err)}`],
      testCases: [],
    };
  }
}

function parseJestOutput(stdout: string, stderr: string): Omit<TestRunResult, "stdout" | "stderr" | "exitCode"> {
  try {
    const jsonMatch = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
    if (!jsonMatch) {
      return createFallbackResult(stdout, stderr, "No JSON output found from Jest");
    }

    const data = JSON.parse(jsonMatch[0]);
    const testCases: TestCaseResult[] = [];

    let passed = 0, failed = 0, skipped = 0;

    for (const testFile of data.testResults || []) {
      for (const result of testFile.assertionResults || []) {
        const status = result.status === "passed" ? "passed"
          : result.status === "failed" ? "failed"
          : "skipped";

        testCases.push({
          name: result.fullName || result.title,
          status,
          error: result.failureMessages?.join("\n"),
          duration: result.duration,
        });

        if (status === "passed") passed++;
        else if (status === "failed") failed++;
        else skipped++;
      }
    }

    return {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      errors: [],
      testCases,
    };
  } catch {
    return createFallbackResult(stdout, stderr, "Failed to parse Jest JSON output");
  }
}

function parseVitestOutput(stdout: string, stderr: string): Omit<TestRunResult, "stdout" | "stderr" | "exitCode"> {
  // Vitest JSON output similar to Jest
  return parseJestOutput(stdout, stderr);
}

function parsePytestOutput(stdout: string, stderr: string): Omit<TestRunResult, "stdout" | "stderr" | "exitCode"> {
  try {
    const jsonMatch = stdout.match(/\{[\s\S]*"tests"[\s\S]*\}/);
    if (!jsonMatch) {
      return createFallbackResult(stdout, stderr, "No JSON output found from pytest");
    }

    const data = JSON.parse(jsonMatch[0]);
    const testCases: TestCaseResult[] = [];

    let passed = 0, failed = 0, skipped = 0;

    for (const test of data.tests || []) {
      const status = test.outcome === "passed" ? "passed"
        : test.outcome === "failed" ? "failed"
        : "skipped";

      testCases.push({
        name: test.nodeid,
        status,
        error: test.call?.longrepr,
        duration: test.call?.duration ? test.call.duration * 1000 : undefined,
      });

      if (status === "passed") passed++;
      else if (status === "failed") failed++;
      else skipped++;
    }

    return {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      errors: [],
      testCases,
    };
  } catch {
    return createFallbackResult(stdout, stderr, "Failed to parse pytest JSON output");
  }
}

function parseMochaOutput(stdout: string, stderr: string): Omit<TestRunResult, "stdout" | "stderr" | "exitCode"> {
  try {
    const jsonMatch = stdout.match(/\{[\s\S]*"stats"[\s\S]*\}/);
    if (!jsonMatch) {
      return createFallbackResult(stdout, stderr, "No JSON output found from Mocha");
    }

    const data = JSON.parse(jsonMatch[0]);
    const testCases: TestCaseResult[] = [];

    let passed = 0, failed = 0, skipped = 0;

    for (const test of data.tests || []) {
      const status = test.pass ? "passed"
        : test.fail ? "failed"
        : "skipped";

      testCases.push({
        name: test.fullTitle,
        status,
        error: test.err?.message,
        duration: test.duration,
      });

      if (status === "passed") passed++;
      else if (status === "failed") failed++;
      else skipped++;
    }

    return {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      errors: [],
      testCases,
    };
  } catch {
    return createFallbackResult(stdout, stderr, "Failed to parse Mocha JSON output");
  }
}

function createFallbackResult(stdout: string, stderr: string, error: string): Omit<TestRunResult, "stdout" | "stderr" | "exitCode"> {
  // Try to extract some basic info from text output
  const passMatch = stdout.match(/(\d+)\s+pass/i);
  const failMatch = stdout.match(/(\d+)\s+fail/i);

  const passed = passMatch ? parseInt(passMatch[1]) : 0;
  const failed = failMatch ? parseInt(failMatch[1]) : 0;

  return {
    passed,
    failed,
    skipped: 0,
    total: passed + failed,
    errors: [error],
    testCases: [],
  };
}

function createEmptyResult(): Omit<TestRunResult, "stdout" | "stderr" | "exitCode"> {
  return {
    passed: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    errors: [],
    testCases: [],
  };
}
