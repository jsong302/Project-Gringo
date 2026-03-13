import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import { getOrCreateUser, getUserById, markOnboarded } from '../../src/services/userService';

const TEST_DB_PATH = './data/test-onboarding.db';

describe('Onboarding Handler', () => {
  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    await initDb({ path: TEST_DB_PATH });
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  describe('markOnboarded', () => {
    it('should set onboarded flag to true', () => {
      const user = getOrCreateUser('U_ONBOARD_1', 'Test Onboard');
      expect(user.onboarded).toBe(false);

      markOnboarded(user.id);

      const updated = getUserById(user.id);
      expect(updated).not.toBeNull();
      expect(updated!.onboarded).toBe(true);
    });

    it('should be idempotent', () => {
      const user = getOrCreateUser('U_ONBOARD_2', 'Test Idempotent');
      markOnboarded(user.id);
      markOnboarded(user.id); // should not throw

      const updated = getUserById(user.id);
      expect(updated!.onboarded).toBe(true);
    });
  });

  describe('new user default state', () => {
    it('should have onboarded = false by default', () => {
      const user = getOrCreateUser('U_ONBOARD_3', 'New User');
      expect(user.onboarded).toBe(false);
      expect(user.level).toBe(1);
    });
  });

  describe('handleOnboardCommand', () => {
    it('should open a DM and send welcome messages', async () => {
      const { handleOnboardCommand } = await import('../../src/handlers/onboardingHandler');

      const messages: any[] = [];
      const mockClient = {
        conversations: {
          open: vi.fn().mockResolvedValue({ channel: { id: 'D_TEST_DM' } }),
        },
        chat: {
          postMessage: vi.fn().mockImplementation(async (msg: any) => {
            messages.push(msg);
          }),
        },
      };

      const responses: any[] = [];
      const mockRespond = vi.fn().mockImplementation(async (msg: any) => {
        responses.push(msg);
      });

      await handleOnboardCommand('U_ONBOARD_CMD', mockClient, mockRespond);

      // Should have opened a DM
      expect(mockClient.conversations.open).toHaveBeenCalledWith({ users: 'U_ONBOARD_CMD' });

      // Should have sent welcome + level picker (2 messages)
      expect(messages.length).toBe(2);
      expect(messages[0].channel).toBe('D_TEST_DM');

      // Should have confirmed via ephemeral
      expect(responses.length).toBe(1);
      expect(responses[0].text).toContain('DM');
    });

    it('should handle DM open failure gracefully', async () => {
      const { handleOnboardCommand } = await import('../../src/handlers/onboardingHandler');

      const mockClient = {
        conversations: {
          open: vi.fn().mockRejectedValue(new Error('cannot_dm_bot')),
        },
        chat: { postMessage: vi.fn() },
      };

      const responses: any[] = [];
      const mockRespond = vi.fn().mockImplementation(async (msg: any) => {
        responses.push(msg);
      });

      await handleOnboardCommand('U_ONBOARD_FAIL', mockClient, mockRespond);

      // Should have sent error response
      expect(responses.length).toBe(1);
      expect(responses[0].text).toContain('Could not send you a DM');
    });
  });
});
