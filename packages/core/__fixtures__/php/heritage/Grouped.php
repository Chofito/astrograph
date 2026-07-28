<?php

namespace App\Other;

/** Grouped-use aliases: DataObject (plain group member) and Base (aliased). */
use Magento\Framework\{DataObject, Model\AbstractModel as Base};

class UsesGrouped extends DataObject
{
}

class UsesGroupedAlias extends Base
{
}
