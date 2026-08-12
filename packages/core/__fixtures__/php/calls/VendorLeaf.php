<?php

namespace App;

class VendorLeaf extends \Magento\Framework\Model\AbstractModel
{
    public function loadRow(): void
    {
        $this->getData();
    }
}
