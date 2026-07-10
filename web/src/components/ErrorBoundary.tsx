import { Component, type ErrorInfo, type ReactNode } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() { return this.state.error ? <div className="lc-empty"><h3>Something went wrong</h3><p className="muted">{this.state.error.message}</p><button className="btn primary" onClick={() => this.setState({ error: null })}>Try again</button></div> : this.props.children; }
}
