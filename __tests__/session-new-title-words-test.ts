import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

describe('/session new title parsing', () => {
  it.each([
    ['/session new Fresh talk', 'Fresh talk'],
    ['/session new "Fresh talk"', 'Fresh talk'],
    ['/session new ""', undefined],
    ['/session new', undefined],
  ] as const)('for %s forwards the parsed title', async (input, expectedTitle) => {
    const createNewSession = jest.fn();
    await executeGatewaySlashCommand(input, {
      hello: null,
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn(),
      createNewSession,
    });

    expect(createNewSession).toHaveBeenCalledTimes(1);
    expect(createNewSession).toHaveBeenCalledWith(expectedTitle);
  });
});
