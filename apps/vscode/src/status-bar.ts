import * as vscode from 'vscode';

import type { AnalysisResult } from '@aiconfig/core';
import { countBySeverity } from '@aiconfig/core';

/** A compact indicator of whether the repository is in sync. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  private readonly configurationListener: vscode.Disposable;

  public constructor() {
    this.item.command = 'aiconfig.status';
    // Without this, toggling the setting has no effect until the next analysis.
    this.configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('aiconfig.showStatusBar')) {
        this.render();
      }
    });
  }

  public setNotInitialized(): void {
    this.item.text = '$(circle-slash) AI Config';
    this.item.tooltip = 'AI Config: not initialized. Click to see status.';
    this.item.backgroundColor = undefined;
    this.render();
  }

  public setUnavailable(): void {
    this.item.hide();
  }

  public setFailed(message: string): void {
    this.item.text = '$(error) AI Config';
    this.item.tooltip = `AI Config: ${message}`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.render();
  }

  public setAnalysis(analysis: AnalysisResult): void {
    const errors = countBySeverity(analysis.diagnostics, 'error');
    const warnings = countBySeverity(analysis.diagnostics, 'warning');
    const drifted = analysis.providers.filter((provider) => provider.status === 'drift').length;
    const pending = analysis.providers.filter((provider) => provider.status === 'pending').length;

    if (errors > 0) {
      this.item.text = `$(error) AI Config ${String(errors)}`;
      this.item.tooltip = `AI Config: ${plural(errors, 'error')}. Click to see status.`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (drifted > 0) {
      this.item.text = `$(warning) AI Config ${String(drifted)}`;
      this.item.tooltip = `AI Config: ${plural(drifted, 'provider')} with modified generated files.`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (pending > 0) {
      this.item.text = `$(sync) AI Config`;
      this.item.tooltip = 'AI Config: changes are waiting to be synchronized.';
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = '$(check) AI Config';
      this.item.tooltip =
        warnings > 0
          ? `AI Config: synchronized, ${plural(warnings, 'compatibility warning')}.`
          : 'AI Config: synchronized.';
      this.item.backgroundColor = undefined;
    }

    this.render();
  }

  private render(): void {
    if (vscode.workspace.getConfiguration('aiconfig').get<boolean>('showStatusBar', true)) {
      this.item.show();
    } else {
      this.item.hide();
    }
  }

  public dispose(): void {
    this.configurationListener.dispose();
    this.item.dispose();
  }
}

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
