// Discussion screen (placeholder — built out in Phase B task 4). Resolves the active project +
// paper slug and will host the streaming chat + audio.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';

import { useSession } from '@/api/queries';
import { TopBar } from '@/components/TopBar';
import { useActiveProject } from '@/store/project';
import { Screen, Text } from '@/ui';
import { space } from '@/theme/tokens';

export default function DiscussionScreen() {
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { activePid } = useActiveProject();
  const session = useSession(activePid, slug ?? null);

  return (
    <Screen edges={['top']}>
      <TopBar title={session.data?.paper.title ?? 'Discussion'} onBack={() => router.back()} />
      <View style={{ padding: space.lg }}>
        <Text variant="body">
          {session.isLoading
            ? 'Loading…'
            : `Discussion for "${slug}" — streaming chat + audio coming next.`}
        </Text>
      </View>
    </Screen>
  );
}
