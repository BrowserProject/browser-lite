// Native tests of WTF fixes in engine/patches, built with the engine (target
// BrowserLiteWTFTests in engine/engine.cmake) and run in node by wtf-test.mjs.
// Prints "ok <name>" or "FAIL <name>: <reason>" per test; a crash aborts the program.
#include "config.h"

#include <cstdio>
#include <wtf/MainThread.h>
#include <wtf/RedBlackTree.h>
#include <wtf/RunLoop.h>
#include <wtf/StdLibExtras.h>

namespace {

int failures = 0;

void report(const char* name, bool ok, const char* reason)
{
    if (ok)
        std::printf("ok %s\n", name);
    else {
        std::printf("FAIL %s: %s\n", name, reason);
        failures++;
    }
    std::fflush(stdout);
}

class TestNode final : public WTF::RedBlackTree<TestNode, int>::Node {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(TestNode);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(TestNode);
public:
    explicit TestNode(int key)
        : m_key(key)
    {
    }
    int key() const { return m_key; }

private:
    int m_key;
};

// Patch 0046: RedBlackTree::remove() clears the links of the removed node, so it
// holds no CheckedPtr to its former child (which may be deleted before it is
// inserted again).
void removedNodeKeepsNoLinks()
{
    WTF::RedBlackTree<TestNode, int> tree;
    auto* z = new TestNode(20);
    auto* a = new TestNode(30);
    tree.insert(z);
    tree.insert(a); // right child of z
    tree.remove(z);
    tree.remove(a);
    bool unlinked = !a->checkedPtrCount();
    report("red-black-tree-removed-node-keeps-no-links", unlinked, "the removed node still points to its former child");
    if (!unlinked) {
        // Deleting a first would zero it and crash at the next insert of z
        delete z;
        delete a;
        return;
    }
    delete a;
    tree.insert(z);
    bool reinserted = tree.first() == z && tree.size() == 1;
    tree.remove(z);
    delete z;
    report("red-black-tree-reinsert-after-child-deleted", reinserted, "z is not the only node after inserting it again");
}

// The crash of the field (RunLoop::TimerBase::start -> RedBlackTree::insert ->
// CheckedPtr to a dead object): a stopped timer is started again after the
// timer that was its child in the schedule tree has been destroyed.
void timerRestartsAfterChildDestroyed()
{
    auto& runLoop = WTF::RunLoop::currentSingleton();
    auto z = WTF::makeUnique<WTF::RunLoop::Timer>(runLoop, "Z"_s, [] { });
    auto a = WTF::makeUnique<WTF::RunLoop::Timer>(runLoop, "A"_s, [] { });
    z->startOneShot(20_ms);
    a->startOneShot(30_ms); // right child of z
    z->stop();
    a = nullptr;
    z->startOneShot(20_ms);
    bool active = z->isActive();
    z->stop();
    report("runloop-timer-restarts-after-child-destroyed", active, "z is not active after starting it again");
}

} // namespace

int main()
{
    WTF::initializeMainThread();
    removedNodeKeepsNoLinks();
    timerRestartsAfterChildDestroyed();
    std::printf("%s\n", failures ? "WTF tests failed" : "WTF tests ok");
    return failures ? 1 : 0;
}
