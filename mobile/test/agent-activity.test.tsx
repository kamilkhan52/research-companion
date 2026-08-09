import { render } from '@testing-library/react-native';

import { AgentActivity } from '@/components/AgentActivity';

describe('AgentActivity', () => {
  it('announces user-facing progress without internal thinking language', () => {
    const screen = render(
      <AgentActivity status="Preparing a response…" detail="Reviewing the paper." testID="activity" />,
    );
    const activity = screen.getByTestId('activity');
    expect(activity.props.accessibilityRole).toBe('progressbar');
    expect(activity.props.accessibilityLabel).toBe('Preparing a response…. Reviewing the paper.');
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });

  // DR-006. The chat pending card passes no `detail`, because every value it used to pass merely
  // restated the status in longer words. The prop itself stays: the notes-revision card uses it
  // for real progress ("N characters drafted"), which is state, not narration.
  it('renders nothing beneath the status when no detail is given', () => {
    const screen = render(<AgentActivity status="Reviewing the discussion…" testID="activity" />);
    expect(screen.getByTestId('activity').props.accessibilityLabel)
      .toBe('Reviewing the discussion…');
    expect(screen.queryByText(/Connecting your message/)).toBeNull();
  });
});
