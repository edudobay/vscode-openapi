/*
 Copyright (c) 42Crunch Ltd. All rights reserved.
 Licensed under the GNU Affero General Public License version 3. See LICENSE.txt in the project root for license information.
*/

import * as vscode from "vscode";

import {
  ScanRunConfig,
  OasWithOperationAndConfig,
  ShowScanReportMessage,
  ScandManagerConnection,
} from "@xliic/common/scan";

import { replaceEnv } from "@xliic/common/env";
import { Preferences } from "@xliic/common/prefs";
import { Webapp } from "@xliic/common/webapp/scan";
import { Config } from "@xliic/common/config";
import { GeneralError, ShowGeneralErrorMessage } from "@xliic/common/error";
import { LogLevel } from "@xliic/common/logging";

import {
  ShowHttpResponseMessage,
  ShowHttpErrorMessage,
  HttpRequest,
  HttpError,
} from "@xliic/common/http";

import { WebView } from "../../web-view";
import { Cache } from "../../cache";
import { PlatformStore } from "../stores/platform-store";
import { Configuration } from "../../configuration";
import { EnvStore } from "../../envstore";
import { executeHttpRequestRaw } from "../../tryit/http-handler";
import { getLocationByPointer } from "../../audit/util";
import * as managerApi from "../api-scand-manager";
import { ScandManagerJobStatus } from "../api-scand-manager";
import { Logger } from "../types";
import { loadConfig } from "../../util/config";
import { AuditWebView } from "../../audit/view";
import { parseAuditReport } from "../../audit/audit";
import { AuditContext, MappingNode } from "../../types";
import { setAudit, clearAudit } from "../../audit/service";

export class ScanWebView extends WebView<Webapp> {
  private isNewApi: boolean = false;
  private document?: vscode.TextDocument;
  private auditReport?: {
    report: any;
    mapping: MappingNode;
  };

  constructor(
    extensionPath: string,
    private cache: Cache,
    private configuration: Configuration,
    private secrets: vscode.SecretStorage,
    private store: PlatformStore,
    private envStore: EnvStore,
    private prefs: Record<string, Preferences>,
    private auditView: AuditWebView,
    private auditContext: AuditContext
  ) {
    super(extensionPath, "scan", "Scan", vscode.ViewColumn.Two);
    envStore.onEnvironmentDidChange((env) => {
      if (this.isActive()) {
        this.sendRequest({
          command: "loadEnv",
          payload: { default: undefined, secrets: undefined, [env.name]: env.environment },
        });
      }
    });

    vscode.window.onDidChangeActiveColorTheme((e) => {
      if (this.isActive()) {
        this.sendColorTheme(e);
      }
    });
  }

  hostHandlers: Webapp["hostHandlers"] = {
    runScan: async (
      scanConfig: ScanRunConfig
    ): Promise<ShowScanReportMessage | ShowGeneralErrorMessage> => {
      try {
        const config = await loadConfig(this.configuration, this.secrets);

        return await runScan(
          this.store,
          this.envStore,
          scanConfig,
          config,
          makeLogger(this),
          this.isNewApi
        );
      } catch (ex: any) {
        const message =
          ex?.response?.statusCode === 409 &&
          ex?.response?.body?.code === 109 &&
          ex?.response?.body?.message === "limit reached"
            ? "You have reached your maximum number of APIs. Please contact support@42crunch.com to upgrade your account."
            : "Failed to run scan: " + ex.message;

        return {
          command: "showGeneralError",
          payload: {
            message,
          },
        };
      }
    },

    sendHttpRequest: async (
      request: HttpRequest
    ): Promise<ShowHttpResponseMessage | ShowHttpErrorMessage> => {
      try {
        const response = await executeHttpRequestRaw(request);
        return {
          command: "showHttpResponse",
          payload: response,
        };
      } catch (e) {
        return {
          command: "showHttpError",
          payload: e as HttpError,
        };
      }
    },

    sendCurlRequest: async (curl: string): Promise<void> => {
      return copyCurl(curl);
    },

    savePrefs: async (prefs: Preferences) => {
      if (this.document) {
        const uri = this.document.uri.toString();
        this.prefs[uri] = {
          ...this.prefs[uri],
          ...prefs,
        };
      }
    },

    showEnvWindow: async () => {
      vscode.commands.executeCommand("openapi.showEnvironment");
    },

    showJsonPointer: async (payload: string) => {
      if (this.document) {
        let editor: vscode.TextEditor | undefined = undefined;

        // check if document is already open
        for (const visibleEditor of vscode.window.visibleTextEditors) {
          if (visibleEditor.document.uri.toString() === this.document.uri.toString()) {
            editor = visibleEditor;
          }
        }

        if (!editor) {
          editor = await vscode.window.showTextDocument(this.document, vscode.ViewColumn.One);
        }
        const root = this.cache.getParsedDocument(editor.document);
        const lineNo = getLocationByPointer(editor.document, root, payload)[0];
        const textLine = editor.document.lineAt(lineNo);
        editor.selection = new vscode.Selection(lineNo, 0, lineNo, 0);
        editor.revealRange(textLine.range, vscode.TextEditorRevealType.AtTop);
      }
    },

    showAuditReport: async () => {
      const uri = this.document!.uri.toString();
      const audit = await parseAuditReport(
        this.cache,
        this.document!,
        this.auditReport!.report,
        this.auditReport!.mapping
      );
      setAudit(this.auditContext, uri, audit);
      await this.auditView.showReport(audit);
    },
  };

  onDispose(): void {
    this.document = undefined;
    super.onDispose();
  }

  async sendStartScan(document: vscode.TextDocument) {
    this.document = document;
    this.auditReport = undefined;
    return this.sendRequest({ command: "startScan", payload: undefined });
  }

  async sendScanOperation(document: vscode.TextDocument, payload: OasWithOperationAndConfig) {
    this.document = document;
    this.auditReport = undefined;
    clearAudit(this.auditContext, this.document.uri.toString());
    this.sendRequest({ command: "loadEnv", payload: await this.envStore.all() });
    this.sendLoadConfig();
    const prefs = this.prefs[this.document.uri.toString()];
    if (prefs) {
      this.sendRequest({ command: "loadPrefs", payload: prefs });
    }
    return this.sendRequest({ command: "scanOperation", payload });
  }

  async sendAuditError(document: vscode.TextDocument, report: any, mapping: MappingNode) {
    this.document = document;

    this.auditReport = {
      report,
      mapping,
    };

    return this.sendRequest({
      command: "showGeneralError",
      payload: {
        message:
          "OpenAPI has failed Security Audit. Please run API Security Audit, fix the issues and try running the Scan again.",
        code: "audit-error",
      },
    });
  }

  async sendLoadConfig() {
    const config = await loadConfig(this.configuration, this.secrets);
    this.sendRequest({
      command: "loadConfig",
      payload: config,
    });
  }

  async sendLogMessage(message: string, level: LogLevel) {
    this.sendRequest({
      command: "showLogMessage",
      payload: { message, level, timestamp: new Date().toISOString() },
    });
  }

  setNewApi(isNewApi: boolean) {
    this.isNewApi = isNewApi;
  }
}

function makeLogger(view: { sendLogMessage: (message: string, level: LogLevel) => void }): Logger {
  return {
    debug: (message: string) => view.sendLogMessage(message, "debug"),
    info: (message: string) => view.sendLogMessage(message, "info"),
    warning: (message: string) => view.sendLogMessage(message, "warning"),
    error: (message: string) => view.sendLogMessage(message, "error"),
    fatal: (message: string) => view.sendLogMessage(message, "fatal"),
  };
}

async function runScan(
  store: PlatformStore,
  envStore: EnvStore,
  scanConfig: ScanRunConfig,
  config: Config,
  logger: Logger,
  isNewApi: boolean
): Promise<ShowScanReportMessage | ShowGeneralErrorMessage> {
  logger.info(`Starting API Conformance Scan`);
  const tmpApi = await store.createTempApi(scanConfig.rawOas);

  logger.info(`Created temp API "${tmpApi.apiId}", waiting for Security Audit`);

  const audit = await store.getAuditReport(tmpApi.apiId);
  if (audit?.data.openapiState !== "valid") {
    await store.clearTempApi(tmpApi);
    return {
      command: "showGeneralError",
      payload: {
        message:
          "OpenAPI has failed Security Audit. Please run API Security Audit, fix the issues and try running the Scan again.",
      },
    };
  }

  logger.info(`Security Audit check is successful`);

  if (isNewApi) {
    await store.createScanConfigNew(tmpApi.apiId, "updated", scanConfig.config);
  } else {
    await store.createScanConfig(tmpApi.apiId, "updated", scanConfig.config);
  }

  const configs = await store.getScanConfigs(tmpApi.apiId);

  const c = isNewApi
    ? await store.readScanConfig(configs[0].configuration.id)
    : await store.readScanConfig(configs[0].scanConfigurationId);

  const token = isNewApi ? c.token : c.scanConfigurationToken;

  const failure =
    config.scanRuntime === "docker"
      ? await runScanWithDocker(envStore, scanConfig, config, token)
      : await runScanWithScandManager(envStore, scanConfig, config, logger, token);

  if (failure !== undefined) {
    // cleanup
    try {
      await store.clearTempApi(tmpApi);
    } catch (ex) {
      console.log(`Failed to cleanup temp api ${tmpApi.apiId}: ${ex}`);
    }

    return {
      command: "showGeneralError",
      payload: failure,
    };
  }

  const reportId = await waitForReport(store, tmpApi.apiId, 30000, isNewApi);

  if (reportId === undefined) {
    return {
      command: "showGeneralError",
      payload: { message: "Failed to load scan report from the platform" },
    };
  }

  const report = isNewApi
    ? await store.readScanReportNew(reportId!)
    : await store.readScanReport(reportId!);

  const parsed = JSON.parse(Buffer.from(report, "base64").toString("utf-8"));

  await store.clearTempApi(tmpApi);

  logger.info(`Finished API Conformance Scan`);

  return {
    command: "showScanReport",
    // FIXME path and method are ignored by the UI, fix message to make 'em optionals
    payload: {
      path: "/",
      method: "get",
      report: parsed,
      security: undefined,
    },
  };
}

async function runScanWithDocker(
  envStore: EnvStore,
  scanConfig: ScanRunConfig,
  config: Config,
  token: string
) {
  const terminal = findOrCreateTerminal();

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(scanConfig.env)) {
    env[name] = replaceEnv(value, await envStore.all());
  }

  const services =
    config.platformServices.source === "auto"
      ? config.platformServices.auto
      : config.platformServices.manual;

  env["SCAN_TOKEN"] = token;
  env["PLATFORM_SERVICE"] = services!;

  const envString = Object.entries(env)
    .map(([key, value]) => `-e ${key}='${value}'`)
    .join(" ");

  const hostNetwork =
    config.docker.useHostNetwork && (config.platform == "linux" || config.platform == "freebsd")
      ? "--network host"
      : "";

  terminal.sendText(`docker run ${hostNetwork} --rm ${envString} ${config.scanImage}`);
  terminal.show();
}

async function runScanWithScandManager(
  envStore: EnvStore,
  scanConfig: ScanRunConfig,
  config: Config,
  logger: Logger,
  token: string
): Promise<GeneralError | undefined> {
  logger.info(`Using scand-manager`);

  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(scanConfig.env)) {
    env[name] = replaceEnv(value, await envStore.all());
  }

  let job: ScandManagerJobStatus | undefined = undefined;

  const services =
    config.platformServices.source === "auto"
      ? config.platformServices.auto
      : config.platformServices.manual;

  try {
    job = await managerApi.createJob(
      token,
      services!,
      config.scanImage,
      env,
      config.scandManager,
      logger
    );
  } catch (ex) {
    return {
      message: `Failed to create scand-manager job: ${ex}`,
    };
  }

  logger.info(`Created scand-manager job: "${job.name}"`);

  if (job.status === "failed") {
    // TODO introduce settings whether delete failed jobs or not
    return {
      message: `Failed to create scand-manager job "${job.name}", received unexpected status: ${job.status}`,
    };
  }

  const error = await waitForScandJob(job.name, config.scandManager, logger, 30000);

  if (error) {
    return error;
  }

  // job has completed, remove it
  await managerApi.deleteJobStatus(job.name, config.scandManager, logger);

  return undefined;
}

async function waitForReport(
  store: PlatformStore,
  apiId: string,
  maxDelay: number,
  isNewApi: boolean
): Promise<string | undefined> {
  let currentDelay = 0;
  while (currentDelay < maxDelay) {
    const reports = await store.listScanReports(apiId);
    if (reports.length > 0) {
      return isNewApi ? reports[0].report.taskId : reports[0].taskId;
    }
    console.log("Waiting for report to become available");
    await delay(1000);
    currentDelay = currentDelay + 1000;
  }
  console.log("Failed to read report");
  return undefined;
}

async function waitForScandJob(
  name: string,
  manager: ScandManagerConnection,
  logger: Logger,
  maxDelay: number
): Promise<GeneralError | undefined> {
  let currentDelay = 0;
  while (currentDelay < maxDelay) {
    const status = await managerApi.readJobStatus(name, manager, logger);
    // Status unknown may mean the job is not finished, keep waiting
    if (status.status === "succeeded") {
      return undefined;
    } else if (status.status === "failed") {
      const log = await managerApi.readJobLog(name, manager, logger);
      return { message: `Scand-manager job "${name}" has failed`, details: log };
    }
    logger.info(`Waiting for job: "${name}", status: "${status.status}"`);
    await delay(1000);
    currentDelay = currentDelay + 1000;
  }
  return { message: `Timed out waiting for scand-manager job "${name}" to finish` };
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findOrCreateTerminal() {
  const name = "scan";
  for (const terminal of vscode.window.terminals) {
    if (terminal.name === name && terminal.exitStatus === undefined) {
      return terminal;
    }
  }
  return vscode.window.createTerminal({ name });
}

async function runCurl(curl: string) {
  const terminal = findOrCreateTerminal();
  terminal.sendText(curl);
  terminal.show();
}

async function copyCurl(curl: string) {
  vscode.env.clipboard.writeText(curl);
  const disposable = vscode.window.setStatusBarMessage(`Curl command copied to the clipboard`);
  setTimeout(() => disposable.dispose(), 1000);
}
