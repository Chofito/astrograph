<?php

namespace App\Code;

use Vendor\Status\Cron\Cleanup as CleanupCron;
use Magento\Framework\{DataObject, Model\AbstractModel as Base};
use Vendor\Pkg\Thing;

/**
 * Covers: plain use, aliased use, grouped use, leading-backslash absolute,
 * extends + implements together, and a missing on-disk class (external).
 */
class Child extends CleanupCron implements Thing, \Absolute\Iface, MissingGeneratedFactory
{
}
