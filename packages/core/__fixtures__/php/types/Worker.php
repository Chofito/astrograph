<?php

namespace App\Service;

use Vendor\Di\CleanupCron;
use Vendor\Di\Thing;
use Vendor\Di\ExternalService;

/**
 * Type-position edges: simple_parameter, property_promotion_parameter,
 * typed property, return type. Scalars must not produce edges.
 */
class Worker
{
    private CleanupCron $cron;

    public function __construct(
        private readonly Thing $thing,
        CleanupCron $cron,
        string $label = "",
        float $qtyEpsilon = 0.0001,
    ) {
        $this->cron = $cron;
    }

    public function run(): Thing
    {
        return $this->thing;
    }

    public function label(): string
    {
        return "";
    }

    public function missing(): \Vendor\Missing\Factory
    {
        throw new \RuntimeException("missing");
    }
}
