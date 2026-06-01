/**
 * Error boundary wrapping the per-connection panels (schema explorer, data
 * workspace). Before 1.0.2 a render-time exception inside one of these
 * subtrees — most visibly the multi-DB schema explorer while a filter was
 * being cleared — would unmount the whole panel and leave a blank white area
 * (the outer toolbar survived because it lives above this boundary). React
 * gives no in-app signal for an uncaught render error other than the blanked
 * tree, so we catch it here and render the stack instead of nothing.
 *
 * This doubles as a permanent safety net: any future render crash inside a
 * connection panel now degrades to a legible error card with a retry, rather
 * than a dead screen.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /**
   * Identity of the mounted connection. When it changes (the user switches
   * connection) the boundary resets so a previous crash doesn't stick to an
   * unrelated connection.
   */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ConnectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Clear the captured error when the connection changes so switching away
    // from a crashing connection yields a fresh tree.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the stack reachable from the devtools console too — the on-screen
    // card shows the message, the console shows the component stack.
    console.error("Connection panel crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="flex h-full flex-col gap-3 overflow-auto p-4 text-xs">
          <div className="font-semibold text-destructive">
            Something went wrong rendering this panel.
          </div>
          <pre className="whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ""}
          </pre>
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => this.setState({ error: null })}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
