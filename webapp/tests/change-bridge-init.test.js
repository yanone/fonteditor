const { handleRemoteChangeRefresh } = require('../js/change-bridge-init');

describe('handleRemoteChangeRefresh', () => {
    test('queues remote cache refresh before the first compile request', async () => {
        let resolveRefresh;
        const refreshOrder = [];
        const queueCacheRefresh = jest.fn(() => {
            refreshOrder.push('queue');
            window.fontManager = {
                workerCacheUpdatePromise: Promise.resolve()
            };
            return new Promise((resolve) => {
                resolveRefresh = () => {
                    refreshOrder.push('refresh-resolved');
                    resolve();
                };
            });
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
            expect(window.fontManager.workerCacheUpdatePromise).toBeTruthy();
        });
        const remoteEntries = [
            {
                transactionLabel: 'Drag anchor',
                path: 'glyphs.a.layers.master-regular.anchors.0.x',
                workerReplayTargets: [
                    {
                        glyphName: 'a',
                        layerId: 'master-regular'
                    }
                ]
            }
        ];

        const refreshPromise = handleRemoteChangeRefresh(remoteEntries, {
            requestCompile,
            queueCacheRefresh
        });

        expect(queueCacheRefresh).toHaveBeenCalledWith(
            undefined,
            undefined,
            false,
            {
                workerReplayTargets: [
                    {
                        glyphName: 'a',
                        layerId: 'master-regular'
                    }
                ]
            }
        );
        expect(requestCompile).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenNthCalledWith(
            1,
            'remote-anchor',
            'anchor'
        );
        expect(refreshOrder).toEqual(['queue', 'compile']);

        resolveRefresh();
        await refreshPromise;

        expect(requestCompile).toHaveBeenCalledTimes(2);
        expect(requestCompile).toHaveBeenNthCalledWith(
            2,
            'remote-anchor',
            'anchor'
        );
        expect(refreshOrder).toEqual([
            'queue',
            'compile',
            'refresh-resolved',
            'compile'
        ]);
    });
});
