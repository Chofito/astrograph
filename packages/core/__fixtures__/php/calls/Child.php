<?php

namespace App;

class Child extends ParentService
{
    public function go(): void
    {
        parent::inherited();
        $this->inherited();
    }
}
