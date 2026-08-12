<?php

namespace App;

class Worker
{
    private Dep $typed;

    public function __construct(
        private readonly Dep $promoted,
        Dep $assigned,
        private readonly Contract $contract,
    ) {
        $this->typed = $assigned;
        $this->onlyAssigned = $assigned;
    }

    public function bucketOne(): void
    {
        $this->promoted->run();
        $this->typed->run();
        $this->onlyAssigned->run();
        $this->contract->ping();
        self::staticOk();
        new Dep();
    }

    public static function staticOk(): void
    {
    }
}
