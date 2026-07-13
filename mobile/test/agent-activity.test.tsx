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
});
